import { Resend } from 'resend';
import { render } from '@react-email/components';
import { ClientInvitationEmail } from '../../emails/client-invitation';

// Initialize Resend lazily to ensure dotenv.config() has run
const getResend = (): Resend => {
  const apiKey = process.env.RESEND_API;
  if (!apiKey) {
    throw new Error('RESEND_API environment variable is not set');
  }
  return new Resend(apiKey);
};

interface SendInvitationEmailParams {
  to: string;
  clientName: string;
  agencyName: string;
  invitationToken: string;
}

export class EmailService {
  /**
   * Send client invitation email with Instagram connection link using react-email
   */
  static async sendClientInvitation(params: SendInvitationEmailParams): Promise<{ success: boolean; error?: string }> {
    const { to, clientName, agencyName, invitationToken } = params;

    const invitationUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/invitation/${invitationToken}`;

    try {
      const resend = getResend();

      // Render the React email component to HTML
      const emailHtml = await render(
        ClientInvitationEmail({
          clientName,
          agencyName,
          invitationUrl,
        })
      );

      const { data, error } = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'Safe Replies <azim@cashin.so>',
        to: [to],
        subject: `${agencyName} invited you to Safe Replies`,
        html: emailHtml,
      });

      if (error) {
        console.error('Resend email error:', error);
        return { success: false, error: error.message };
      }

      console.log('Invitation email sent:', data);
      return { success: true };
    } catch (error) {
      console.error('Failed to send invitation email:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send email'
      };
    }
  }
}
