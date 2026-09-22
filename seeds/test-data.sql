-- Test user + test API key for local development and smoke testing.
-- Plaintext key (never stored): np_test_7bc5c02094886b8a8bd2f1eda2774b1b1e3acde3
-- key_hash below is sha256(plaintext key).
INSERT OR IGNORE INTO users (id, email)
VALUES ('usr_test0000000000000000000000', 'test@nanoservices.io');

INSERT OR IGNORE INTO api_keys (id, user_id, name, key_prefix, key_hash)
VALUES (
    'key_test0000000000000000000000',
    'usr_test0000000000000000000000',
    'Local test key',
    'np_test_7bc5',
    '0b7b1c0eb89d6989f554a85d6ff80fd5ff5dc08775026baca515036b108602b6'
);

-- A pre-configured monitor so /monitors returns something on a fresh database.
INSERT OR IGNORE INTO monitors (id, user_id, slug, name, expected_interval_seconds, grace_period_seconds)
VALUES (
    'mon_test0000000000000000000000',
    'usr_test0000000000000000000000',
    'nightly-backup',
    'Nightly backup',
    86400,
    3600
);
