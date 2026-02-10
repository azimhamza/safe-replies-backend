# Database Cleanup Scripts

This directory contains scripts for managing and cleaning up the database.

## clear-database.ts

A comprehensive script for clearing the database and deleting specific users or clients with all their associated data.

### Features

1. **Clear Entire Database**: Removes all data from all tables
2. **Delete Specific User**: Removes a user (agency or creator) and all their associated data
3. **Delete Specific Client**: Removes a client and all their associated data

### Usage

#### Clear Entire Database

```bash
pnpm script:clear-db --all
```

**Warning**: This will delete ALL data from the database. You will be prompted to type "DELETE ALL" to confirm.

#### Delete a Specific User

```bash
pnpm script:clear-db --user user@example.com
```

This will delete:
- The user account
- All clients managed by the user (if agency)
- All Instagram accounts (user's own + clients')
- All Facebook pages
- All posts and comments
- All moderation logs and evidence
- All suspicious accounts and related data
- All filters and settings
- All network and connection data

You will be prompted to type "DELETE user@example.com" to confirm.

#### Delete a Specific Client

```bash
pnpm script:clear-db --client client@example.com
```

This will delete:
- The client account
- All Instagram accounts owned by the client
- All Facebook pages
- All posts and comments
- All moderation logs and evidence
- All suspicious accounts and related data
- All filters and settings

You will be prompted to type "DELETE client@example.com" to confirm.

### Data Deletion Order

The script carefully handles foreign key constraints by deleting data in the following order:

1. Evidence records and moderation logs
2. Comment-related data (reviews, detections, attachments, mappings)
3. Comments
4. Posts
5. Network connections and masterminds
6. Legal cases and evidence mappings
7. Suspicious accounts
8. Filters and settings
9. Instagram and Facebook connections
10. Follower history
11. Instagram accounts and Facebook pages
12. Agency network data
13. Clients
14. Users

### Safety Features

- **Confirmation prompts**: All operations require explicit confirmation
- **Transaction support**: All deletions happen in a single transaction (all or nothing)
- **Clear output**: The script provides detailed progress information
- **Error handling**: Comprehensive error handling and rollback on failure

### Examples

```bash
# View usage information
pnpm script:clear-db

# Clear entire database (requires "DELETE ALL" confirmation)
pnpm script:clear-db --all

# Delete a specific user/agency
pnpm script:clear-db --user agency@example.com

# Delete a specific client
pnpm script:clear-db --client client@example.com
```

### Important Notes

⚠️ **CAUTION**: All deletion operations are **IRREVERSIBLE**. Always:
- Make a database backup before running these scripts
- Double-check the email address before confirming deletion
- Run in a test environment first if possible

### Running While Backend is Running

Yes, this script can safely run while the backend is running. However:
- The script uses database transactions for atomicity
- Be aware that deleting data while it's being accessed may cause temporary errors in the running application
- It's recommended to run during low-traffic periods or with the backend stopped for critical operations

### Technical Details

- Built with Drizzle ORM
- Uses PostgreSQL transactions for data integrity
- Respects all foreign key constraints
- Handles cascading deletions automatically
- Provides comprehensive error messages and rollback on failure
