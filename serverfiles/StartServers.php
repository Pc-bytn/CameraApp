<?php

// WebSocket configurations
$host       = '127.0.0.1';
$port       = 8099;
$serverScript = __DIR__ . '/signaling.php';

// Nginx configuration
$nginxPath = __DIR__. "/nginx/nginx.exe"; // Update this path to your Nginx executable
$nginxPort = 8443; // Default Nginx HTTP port

// Command to start the server in background and capture its PID
$startCmd = sprintf(
    'php %s > /dev/null 2>&1 & echo $!',
    escapeshellarg($serverScript)
);

// Command to start Nginx
$startNginxCmd = sprintf(
    'start /B %s',
    escapeshellarg($nginxPath)
);

/**
 * Checks if a TCP service is listening on the given host and port.
 *
 * @param string $host
 * @param int    $port
 * @param float  $timeout  in seconds
 * @return bool
 */
function isServerRunning(string $host, int $port, float $timeout = 0.5): bool
{
    $errno = $errstr = null;
    $fp = @fsockopen($host, $port, $errno, $errstr, $timeout);
    if ($fp) {
        fclose($fp);
        return true;
    }
    return false;
}

// temporary response array
$response = [
    'running'  => false,
    'started'  => false,
    'message'  => '',
    'pid'      => null,
    'nginx_running' => false,
    'nginx_started' => false,
    'nginx_message' => '',
];


if (isServerRunning($host, $port)) {
    $response['running'] = true;
    $response['message'] = 'WebSocket server is already running.';
} else {
    $pid = trim(shell_exec($startCmd));

    usleep(500000);
    if (isServerRunning($host, $port)) {
        $response['running'] = true;
        $response['started'] = true;
        $response['pid']     = $pid;
        $response['message'] = 'WebSocket server started successfully.';
    } else {
        $response['message'] = 'Failed to start WebSocket server.';
    }
}

// Check and start Nginx if needed
if (isServerRunning($host, $nginxPort)) {
    $response['nginx_running'] = true;
    $response['nginx_message'] = 'Nginx server is already running.';
} else {
    exec($startNginxCmd, $output, $returnVar);
    
    usleep(500000); // Wait for Nginx to start
    if (isServerRunning($host, $nginxPort)) {
        $response['nginx_running'] = true;
        $response['nginx_started'] = true;
        $response['nginx_message'] = 'Nginx server started successfully.';
    } else {
        $response['nginx_message'] = 'Failed to start Nginx server.';
    }
}

// Output result as JSON
header('Content-Type: application/json');
echo json_encode($response, JSON_PRETTY_PRINT);
