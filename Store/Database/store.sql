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

CREATE TABLE IF NOT EXISTS store.drug_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by TEXT,
    updated_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_drug_categories_name_unique
    ON store.drug_categories ((lower(name)));

CREATE INDEX IF NOT EXISTS idx_drug_categories_active_sort
    ON store.drug_categories (is_active, sort_order, name);

CREATE TABLE IF NOT EXISTS store.drug_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID NOT NULL REFERENCES store.drug_categories(id) ON DELETE RESTRICT,
    name VARCHAR(120) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by TEXT,
    updated_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_drug_groups_category_name_unique
    ON store.drug_groups (category_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_drug_groups_category_active_sort
    ON store.drug_groups (category_id, is_active, sort_order, name);
