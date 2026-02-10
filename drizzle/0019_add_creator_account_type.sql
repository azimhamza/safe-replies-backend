-- Add CREATOR to account_type enum
ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'CREATOR';
