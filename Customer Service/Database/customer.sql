CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS customer;

CREATE TABLE IF NOT EXISTS customer.tier_configs (
    tier_name VARCHAR(20) PRIMARY KEY,
    min_points INT NOT NULL,
    point_multiplier DECIMAL(4,2) NOT NULL DEFAULT 1.00,
    discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    benefits TEXT,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer.customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    email VARCHAR(100),
    date_of_birth DATE,
    gender VARCHAR(10),
    address TEXT,

    current_points INT NOT NULL DEFAULT 0,
    total_points_earned INT NOT NULL DEFAULT 0,
    total_points_used INT NOT NULL DEFAULT 0,
    points_expire_at DATE,

    tier VARCHAR(20) NOT NULL REFERENCES customer.tier_configs(tier_name),
    tier_updated_at TIMESTAMPTZ,

    total_orders INT NOT NULL DEFAULT 0,
    total_spent DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    last_purchase_at TIMESTAMPTZ,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer.point_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customer.customers(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL,
    points INT NOT NULL,
    balance_after INT NOT NULL,
    reference_type VARCHAR(20),
    reference_id UUID,
    reference_code VARCHAR(30),
    note TEXT,
    created_by VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer.promotions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    description TEXT,

    discount_type VARCHAR(20) NOT NULL,
    discount_value DECIMAL(12,2) NOT NULL,
    max_discount DECIMAL(12,2),
    min_order_amount DECIMAL(12,2),

    start_date DATE NOT NULL,
    end_date DATE NOT NULL,

    applicable_tiers TEXT[],
    applicable_products UUID[],
    applicable_groups UUID[],

    usage_limit INT,
    usage_per_customer INT,
    current_usage INT NOT NULL DEFAULT 0,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    auto_apply BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer.promotion_usages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promotion_id UUID NOT NULL REFERENCES customer.promotions(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customer.customers(id) ON DELETE SET NULL,
    invoice_id UUID NOT NULL,
    invoice_code VARCHAR(30),
    discount_amount DECIMAL(12,2) NOT NULL,
    is_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
    cancelled_reason TEXT,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customer.customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_code ON customer.customers(code);
CREATE INDEX IF NOT EXISTS idx_customers_tier ON customer.customers(tier);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customer.customers USING gin(to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS idx_point_transactions_customer ON customer.point_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_promotions_code ON customer.promotions(code);
CREATE INDEX IF NOT EXISTS idx_promotions_dates ON customer.promotions(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_promotions_active ON customer.promotions(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_promotion_usages_promotion ON customer.promotion_usages(promotion_id);
CREATE INDEX IF NOT EXISTS idx_promotion_usages_customer ON customer.promotion_usages(customer_id);

INSERT INTO customer.tier_configs (tier_name, min_points, point_multiplier, discount_percent, benefits, display_order)
VALUES
    ('bronze', 0, 1.00, 0.00, 'Basic tier', 1),
    ('silver', 1000, 1.20, 2.00, 'Point x1.2 and 2% discount', 2),
    ('gold', 5000, 1.50, 5.00, 'Point x1.5 and 5% discount', 3),
    ('diamond', 20000, 2.00, 10.00, 'Point x2 and 10% discount', 4)
ON CONFLICT (tier_name) DO NOTHING;
