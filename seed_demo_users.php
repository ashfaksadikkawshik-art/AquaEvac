<?php
/**
 * =============================================================================
 * seed_demo_users.php
 * -----------------------------------------------------------------------------
 * One-time CLI helper to create/reset demo login accounts with REAL password
 * hashes (schema.sql ships placeholder hash strings that cannot be logged
 * into, on purpose, so nobody accidentally ships fake credentials to prod).
 *
 * Run this once after importing schema.sql:
 *   php seed_demo_users.php
 *
 * It is safe to re-run: existing rows with these emails are updated in
 * place rather than duplicated.
 * =============================================================================
 */

declare(strict_types=1);

require_once __DIR__ . '/db_connect.php';

$demo_accounts = [
    ['name' => 'Admin (Aarav Rahman)', 'email' => 'admin@aquaevac.local',     'password' => 'Admin@12345',    'role' => 'admin'],
    ['name' => 'Citizen (Kamal Hossain)', 'email' => 'citizen@aquaevac.local', 'password' => 'Citizen@12345',  'role' => 'citizen'],
    ['name' => 'Responder (Imran Chowdhury)', 'email' => 'responder@aquaevac.local', 'password' => 'Responder@12345', 'role' => 'responder'],
];

$pdo = get_db_connection();

foreach ($demo_accounts as $acc) {
    $hash = password_hash($acc['password'], PASSWORD_DEFAULT);

    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = :email');
    $stmt->execute(['email' => $acc['email']]);
    $existing = $stmt->fetch();

    if ($existing) {
        $pdo->prepare('UPDATE users SET name = :name, password = :password, role = :role WHERE id = :id')
            ->execute(['name' => $acc['name'], 'password' => $hash, 'role' => $acc['role'], 'id' => $existing['id']]);
        echo "Updated: {$acc['email']} ({$acc['role']})\n";
    } else {
        $pdo->prepare('INSERT INTO users (name, email, password, role) VALUES (:name, :email, :password, :role)')
            ->execute(['name' => $acc['name'], 'email' => $acc['email'], 'password' => $hash, 'role' => $acc['role']]);
        echo "Created: {$acc['email']} ({$acc['role']})\n";
    }
}

echo "\nDone. Demo login credentials:\n";
foreach ($demo_accounts as $acc) {
    echo "  [{$acc['role']}]  {$acc['email']}  /  {$acc['password']}\n";
}
