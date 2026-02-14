CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS store;

CREATE TABLE IF NOT EXISTS store.info (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    address TEXT,
    phone VARCHAR(20),
    email VARCHAR(100),
    tax_code VARCHAR(20),
    license_number VARCHAR(50),
    owner_name VARCHAR(100),
    logo_url TEXT,
    bank_account VARCHAR(50),
    bank_name VARCHAR(100),
    bank_branch VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS store.settings (
    "key" VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    group_name VARCHAR(50) NOT NULL,
    data_type VARCHAR(20) NOT NULL DEFAULT 'string',
    description TEXT,
    is_public BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID
);

CREATE INDEX IF NOT EXISTS idx_settings_group ON store.settings(group_name);
