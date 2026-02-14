SELECT 'CREATE DATABASE pharmar_auth'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pharmar_auth')\gexec

SELECT 'CREATE DATABASE pharmar_store'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pharmar_store')\gexec

SELECT 'CREATE DATABASE pharmar_catalog'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pharmar_catalog')\gexec

SELECT 'CREATE DATABASE pharmar_customer'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pharmar_customer')\gexec
