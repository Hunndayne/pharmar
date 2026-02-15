CREATE SCHEMA IF NOT EXISTS catalog;

CREATE TABLE IF NOT EXISTS catalog.drug_groups (
    id UUID PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog.manufacturers (
    id UUID PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    country VARCHAR(50),
    address TEXT,
    phone VARCHAR(20),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog.suppliers (
    id UUID PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    address TEXT,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(100),
    tax_code VARCHAR(20),
    contact_person VARCHAR(100),
    current_debt DECIMAL(15,2) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog.supplier_debt_history (
    id UUID PRIMARY KEY,
    supplier_id UUID NOT NULL REFERENCES catalog.suppliers(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    balance_after DECIMAL(15,2) NOT NULL,
    reference_type VARCHAR(20),
    reference_id UUID,
    note TEXT,
    created_by VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog.products (
    id UUID PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    barcode VARCHAR(50),
    name VARCHAR(300) NOT NULL,
    registration_number VARCHAR(50),
    group_id UUID REFERENCES catalog.drug_groups(id),
    manufacturer_id UUID REFERENCES catalog.manufacturers(id),
    instructions TEXT,
    note TEXT,
    vat_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    other_tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog.product_units (
    id UUID PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
    unit_name VARCHAR(30) NOT NULL,
    conversion_rate INT NOT NULL DEFAULT 1,
    barcode VARCHAR(50),
    selling_price DECIMAL(12,2) NOT NULL,
    is_base_unit BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (product_id, unit_name)
);

CREATE INDEX IF NOT EXISTS idx_drug_groups_code ON catalog.drug_groups(code);
CREATE INDEX IF NOT EXISTS idx_manufacturers_code ON catalog.manufacturers(code);
CREATE INDEX IF NOT EXISTS idx_suppliers_code ON catalog.suppliers(code);
CREATE INDEX IF NOT EXISTS idx_products_code ON catalog.products(code);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON catalog.products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_group ON catalog.products(group_id);
CREATE INDEX IF NOT EXISTS idx_products_manufacturer ON catalog.products(manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_product_units_barcode ON catalog.product_units(barcode);
CREATE INDEX IF NOT EXISTS idx_product_units_product ON catalog.product_units(product_id);
CREATE INDEX IF NOT EXISTS idx_products_name ON catalog.products USING gin(to_tsvector('simple', name));
