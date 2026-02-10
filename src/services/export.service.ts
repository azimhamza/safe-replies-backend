import archiver from 'archiver';
import { db } from '../db';
import { eq } from 'drizzle-orm';
import {
  suspiciousAccounts,
  accountCommentMap,
  comments,
  moderationLogs,
  posts,
  evidenceAttachments,
  extractedIdentifiers
} from '../db/schema';
import { storageService } from './storage.service';

/**
 * Export Service
 * Generates legal export packages for suspicious accounts
 */
class ExportService {
  /**
   * Export suspicious account data as ZIP file
   * @param accountId - Suspicious account ID
   * @param userId - User requesting export
   * @returns ZIP file buffer
   */
  async exportSuspiciousAccount(accountId: string, userId: string): Promise<Buffer> {
    try {
      // Get account data
      const [account] = await db
        .select()
        .from(suspiciousAccounts)
        .where(eq(suspiciousAccounts.id, accountId))
        .limit(1);

      if (!account) {
        throw new Error('Account not found');
      }

      // Get all comments with moderation data
      const accountCommentsData = await db
        .select({
          commentId: comments.id,
          text: comments.text,
          commentedAt: comments.commentedAt,
          isDeleted: comments.isDeleted,
          isHidden: comments.isHidden,
          postId: posts.id,
          postPermalink: posts.permalink,
          category: moderationLogs.category,
          riskScore: moderationLogs.riskScore,
          actionTaken: moderationLogs.actionTaken,
          rationale: moderationLogs.rationale
        })
        .from(accountCommentMap)
        .innerJoin(comments, eq(accountCommentMap.commentId, comments.id))
        .leftJoin(moderationLogs, eq(comments.id, moderationLogs.commentId))
        .leftJoin(posts, eq(comments.postId, posts.id))
        .where(eq(accountCommentMap.suspiciousAccountId, accountId))
        .orderBy(comments.commentedAt); // Chronological order for legal docs

      // Get evidence files
      const evidenceFiles = await db
        .select({
          id: evidenceAttachments.id,
          commentId: evidenceAttachments.commentId,
          fileUrl: evidenceAttachments.fileUrl,
          fileType: evidenceAttachments.fileType,
          uploadNotes: evidenceAttachments.uploadNotes,
          createdAt: evidenceAttachments.createdAt,
          fileSize: evidenceAttachments.fileSize,
          mimeType: evidenceAttachments.mimeType
        })
        .from(evidenceAttachments)
        .innerJoin(accountCommentMap, eq(evidenceAttachments.commentId, accountCommentMap.commentId))
        .where(eq(accountCommentMap.suspiciousAccountId, accountId));

      // Get extracted identifiers
      const identifiers = await db
        .select()
        .from(extractedIdentifiers)
        .where(eq(extractedIdentifiers.suspiciousAccountId, accountId));

      // Create ZIP archive
      const archive = archiver('zip', {
        zlib: { level: 9 } // Maximum compression
      });

      const chunks: Buffer[] = [];
      
      // Collect chunks
      archive.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      // Create promise to wait for archive completion
      const archivePromise = new Promise<Buffer>((resolve, reject) => {
        archive.on('end', () => {
          resolve(Buffer.concat(chunks));
        });
        archive.on('error', reject);
      });

      // Generate export timestamp
      const exportTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const folderName = `${account.commenterUsername}_${accountId}_${exportTimestamp}`;

      // 1. Account Summary JSON
      const accountSummary = {
        account: {
          id: account.id,
          commenterUsername: account.commenterUsername,
          commenterId: account.commenterId,
          averageRiskScore: account.averageRiskScore ? Number(account.averageRiskScore) : 0,
          totalComments: account.totalComments ?? 0,
          blackmailCount: account.blackmailCount,
          threatCount: account.threatCount,
          harassmentCount: account.harassmentCount,
          defamationCount: account.defamationCount,
          spamCount: account.spamCount,
          firstSeenAt: account.firstSeenAt,
          lastSeenAt: account.lastSeenAt,
          isBlocked: account.isBlocked,
          isWatchlisted: account.isWatchlisted
        },
        exportMetadata: {
          exportedAt: new Date().toISOString(),
          exportedBy: userId,
          totalComments: accountCommentsData.length,
          totalEvidence: evidenceFiles.length,
          totalIdentifiers: identifiers.length
        }
      };

      archive.append(JSON.stringify(accountSummary, null, 2), { 
        name: `${folderName}/account_summary.json` 
      });

      // 2. Comments CSV
      const commentsCSV = this.generateCommentsCSV(accountCommentsData);
      archive.append(commentsCSV, { name: `${folderName}/comments.csv` });

      // 3. Identifiers CSV
      if (identifiers.length > 0) {
        const identifiersCSV = this.generateIdentifiersCSV(identifiers);
        archive.append(identifiersCSV, { name: `${folderName}/identifiers.csv` });
      }

      // 4. Evidence metadata
      const evidenceMetadata: Record<string, any[]> = {};
      for (const evidence of evidenceFiles) {
        const commentId = evidence.commentId || 'unlinked';
        if (!evidenceMetadata[commentId]) {
          evidenceMetadata[commentId] = [];
        }
        evidenceMetadata[commentId].push({
          id: evidence.id,
          fileType: evidence.fileType,
          uploadNotes: evidence.uploadNotes,
          uploadedAt: evidence.createdAt,
          fileSize: evidence.fileSize,
          mimeType: evidence.mimeType
        });
      }

      archive.append(JSON.stringify(evidenceMetadata, null, 2), {
        name: `${folderName}/evidence/evidence_metadata.json`
      });

      // 5. Download and add evidence files
      for (const evidence of evidenceFiles) {
        try {
          if (!evidence.fileUrl) continue;
          const key = storageService.extractKeyFromUrl(evidence.fileUrl);
          const fileBuffer = await storageService.downloadFile(key);
          
          // Generate filename: comment_{commentId}_{index}_{timestamp}-{original}
          const timestamp = new Date(evidence.createdAt!).getTime();
          const commentId = evidence.commentId || 'unlinked';
          const extension = evidence.mimeType?.split('/')[1] || 'jpg';
          const filename = `comment_${commentId}_${evidence.id}_${timestamp}.${extension}`;
          
          archive.append(fileBuffer, {
            name: `${folderName}/evidence/${filename}`
          });
        } catch (error) {
          console.error(`Failed to download evidence file: ${evidence.fileUrl}`, error);
          // Continue with other files
        }
      }

      // 6. HTML Report
      const htmlReport = this.generateHTMLReport(account, accountCommentsData, identifiers, evidenceFiles);
      archive.append(htmlReport, { name: `${folderName}/report.html` });

      // 7. README
      const readme = this.generateREADME(account);
      archive.append(readme, { name: `${folderName}/README.txt` });

      // Finalize the archive
      archive.finalize();

      // Wait for archive to complete
      return await archivePromise;
    } catch (error) {
      console.error('Export error:', error);
      throw new Error('Failed to generate export');
    }
  }

  /**
   * Generate comments CSV
   */
  private generateCommentsCSV(comments: any[]): string {
    const headers = ['Date/Time', 'Comment Text', 'Category', 'Risk Score', 'Action Taken', 'Status', 'Post ID', 'Rationale'];
    const rows = comments.map(c => [
      c.commentedAt ? new Date(c.commentedAt).toLocaleString() : '',
      `"${(c.text || '').replace(/"/g, '""')}"`, // Escape quotes
      c.category || '',
      c.riskScore || '',
      c.actionTaken || '',
      c.isDeleted ? 'DELETED' : c.isHidden ? 'HIDDEN' : 'VISIBLE',
      c.postId || '',
      `"${(c.rationale || '').replace(/"/g, '""')}"`
    ]);

    return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
  }

  /**
   * Generate identifiers CSV
   */
  private generateIdentifiersCSV(identifiers: any[]): string {
    const headers = ['Type', 'Value', 'Context', 'Source Comment ID', 'Detected At', 'Confidence'];
    const rows = identifiers.map(i => [
      i.identifierType || '',
      `"${(i.identifierValue || '').replace(/"/g, '""')}"`,
      `"${(i.context || '').replace(/"/g, '""')}"`,
      i.sourceCommentId || '',
      i.detectedAt ? new Date(i.detectedAt).toLocaleString() : '',
      i.confidence || ''
    ]);

    return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
  }

  /**
   * Generate HTML report
   */
  private generateHTMLReport(account: any, comments: any[], identifiers: any[], evidence: any[]): string {
    const now = new Date().toLocaleString();
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Suspicious Account Report - ${account.instagramUsername}</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .header {
      background: #1a1a1a;
      color: white;
      padding: 30px;
      border-radius: 8px;
      margin-bottom: 30px;
    }
    .header h1 {
      margin: 0 0 10px 0;
    }
    .section {
      background: white;
      padding: 25px;
      margin-bottom: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .section h2 {
      margin-top: 0;
      color: #1a1a1a;
      border-bottom: 2px solid #e74c3c;
      padding-bottom: 10px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin: 20px 0;
    }
    .stat-box {
      background: #f8f9fa;
      padding: 15px;
      border-radius: 5px;
      border-left: 4px solid #e74c3c;
    }
    .stat-label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
    }
    .stat-value {
      font-size: 24px;
      font-weight: bold;
      color: #1a1a1a;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 15px;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }
    th {
      background: #f8f9fa;
      font-weight: bold;
    }
    .risk-critical { color: #c0392b; font-weight: bold; }
    .risk-high { color: #e74c3c; }
    .risk-medium { color: #f39c12; }
    .risk-low { color: #27ae60; }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 12px;
      font-weight: bold;
    }
    .badge-deleted { background: #e74c3c; color: white; }
    .badge-hidden { background: #f39c12; color: white; }
    .footer {
      text-align: center;
      color: #666;
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #ddd;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Suspicious Account Report</h1>
    <p><strong>Account:</strong> @${account.instagramUsername} (${account.instagramId})</p>
    <p><strong>Report Generated:</strong> ${now}</p>
  </div>

  <div class="section">
    <h2>Account Overview</h2>
    <div class="stats">
      <div class="stat-box">
        <div class="stat-label">Risk Level</div>
        <div class="stat-value risk-${account.riskLevel?.toLowerCase() || 'low'}">${account.riskLevel || 'UNKNOWN'}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Total Violations</div>
        <div class="stat-value">${account.totalViolations || 0}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Blackmail</div>
        <div class="stat-value">${account.blackmailCount || 0}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Threats</div>
        <div class="stat-value">${account.threatCount || 0}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Harassment</div>
        <div class="stat-value">${account.harassmentCount || 0}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Defamation</div>
        <div class="stat-value">${account.defamationCount || 0}</div>
      </div>
    </div>
    <p><strong>First Seen:</strong> ${account.firstSeenAt ? new Date(account.firstSeenAt).toLocaleString() : 'N/A'}</p>
    <p><strong>Last Seen:</strong> ${account.lastSeenAt ? new Date(account.lastSeenAt).toLocaleString() : 'N/A'}</p>
    <p><strong>Status:</strong> ${account.isBlocked ? 'BLOCKED' : account.isWatchlisted ? 'WATCHLISTED' : 'ACTIVE'}</p>
  </div>

  <div class="section">
    <h2>Comments History (${comments.length} total)</h2>
    <table>
      <thead>
        <tr>
          <th>Date/Time</th>
          <th>Comment</th>
          <th>Category</th>
          <th>Risk</th>
          <th>Action</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${comments.map(c => `
        <tr>
          <td>${c.commentedAt ? new Date(c.commentedAt).toLocaleString() : 'N/A'}</td>
          <td>${this.escapeHTML(c.text || '')}</td>
          <td>${c.category || 'N/A'}</td>
          <td>${c.riskScore || 'N/A'}</td>
          <td>${c.actionTaken || 'N/A'}</td>
          <td>
            ${c.isDeleted ? '<span class="badge badge-deleted">DELETED</span>' : ''}
            ${c.isHidden ? '<span class="badge badge-hidden">HIDDEN</span>' : ''}
          </td>
        </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  ${identifiers.length > 0 ? `
  <div class="section">
    <h2>Extracted Identifiers (${identifiers.length} total)</h2>
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Value</th>
          <th>Context</th>
          <th>Detected At</th>
        </tr>
      </thead>
      <tbody>
        ${identifiers.map(i => `
        <tr>
          <td>${i.identifierType || 'N/A'}</td>
          <td>${this.escapeHTML(i.identifierValue || '')}</td>
          <td>${this.escapeHTML(i.context || '')}</td>
          <td>${i.detectedAt ? new Date(i.detectedAt).toLocaleString() : 'N/A'}</td>
        </tr>
        `).join('')}
      </tbody>
    </table>
  </div>
  ` : ''}

  <div class="section">
    <h2>Evidence Files</h2>
    <p><strong>Total Evidence Files:</strong> ${evidence.length}</p>
    <p>All evidence files have been downloaded and included in the <code>evidence/</code> folder.</p>
    <p>See <code>evidence/evidence_metadata.json</code> for detailed information about each file.</p>
  </div>

  <div class="footer">
    <p>This report was generated automatically by the Instagram Moderation Platform.</p>
    <p>All timestamps are in local time zone.</p>
  </div>
</body>
</html>`;
  }

  /**
   * Generate README file
   */
  private generateREADME(account: any): string {
    return `SUSPICIOUS ACCOUNT EXPORT PACKAGE
=====================================

Account: @${account.instagramUsername}
Instagram ID: ${account.instagramId}
Export Date: ${new Date().toLocaleString()}

CONTENTS:
---------
1. account_summary.json    - Complete account data and metadata
2. comments.csv           - All comments from this account (chronological)
3. identifiers.csv        - Extracted payment handles, contacts, etc.
4. report.html           - Human-readable report (can be printed to PDF)
5. evidence/             - Folder containing all evidence files
   - evidence_metadata.json - Maps evidence files to comments
   - comment_*_*.jpg/mp4    - Evidence files named by comment ID

FILE NAMING:
-----------
Evidence files are named as: comment_{commentId}_{evidenceId}_{timestamp}.{ext}

This allows you to:
- Match evidence to specific comments in comments.csv
- Maintain chronological order
- Avoid filename conflicts

USAGE FOR LEGAL PURPOSES:
-------------------------
This package contains:
- Chronological record of all violations
- Evidence files with timestamps
- Extracted contact information (payment handles, emails, etc.)
- Risk assessments and moderation actions taken

The HTML report can be opened in any browser and printed to PDF.
All data is also available in CSV format for analysis.

PRIVACY & SECURITY:
------------------
This export contains sensitive information. Handle with care.
Do not share without proper authorization.

Generated by Safe Replies Platform
`;
  }

  /**
   * Escape HTML special characters
   */
  private escapeHTML(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }
}

// Export singleton instance
export const exportService = new ExportService();
