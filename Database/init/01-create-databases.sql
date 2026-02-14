SELECT 'CREATE DATABASE pharmar_store'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pharmar_store')\gexec

SELECT 'CREATE DATABASE pharmar_catalog'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pharmar_catalog')\gexec

