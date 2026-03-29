// Global test setup — set env vars needed by all tests
process.env.AUTH_SECRET = "test-secret-for-unit-tests-32chars!!";
process.env.DATABASE_URL = "file:/tmp/test-deployer.db";
process.env.NEXTAUTH_URL = "https://localhost:9444";
