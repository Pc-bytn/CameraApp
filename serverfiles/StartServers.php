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
    'start /B php %s',
    escapeshellarg($serverScript)
);

// Command to start Nginx
$startNginxCmd = sprintf(
    'start /B %s',
    escapeshellarg($nginxPath)
);

// /**
//  * Checks if a TCP service is listening on the given host and port.
//  *
//  * @param string $host
//  * @param int    $port
//  * @param float  $timeout  in seconds
//  * @return bool
//  */
// function isServerRunning(string $host, int $port, float $timeout = 0.5): bool
// {
//     $errno = $errstr = null;
//     $fp = @fsockopen($host, $port, $errno, $errstr, $timeout);
//     if ($fp) {
//         fclose($fp);
//         return true;
//     }
//     return false;
// }

/**
 * Gets the PID of process listening on specified port
 *
 * @param int $port
 * @return int|null
 */
function getProcessIdByPort(int $port): ?int {
    $cmd = "netstat -ano | findstr :$port | findstr LISTENING";
    $output = [];
    exec($cmd, $output);
    
    if (!empty($output)) {
        // Parse the last column (PID) from netstat output
        $line = trim($output[0]);
        if (preg_match('/\s+(\d+)\s*$/', $line, $matches)) {
            return (int)$matches[1];
        }
    }
    return null;
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
    'nginx_exec_output' => null, // Initialize diagnostic field
    'nginx_exec_return_var' => null, // Initialize diagnostic field
];

// Check if WebSocket server is running


if (getProcessIdByPort($port) !== null) {
    $response['running'] = true;
    $response['message'] = "WebSocket server is already running.";
} else {
    shell_exec($startCmd); 

    usleep(1000000);
    if (getProcessIdByPort($port) !== null) {
        $response['running'] = true;
        $response['started'] = true;
        $response['message'] = 'WebSocket server started successfully.';
    } else {
        $response['message'] = 'Failed to start WebSocket server.';
    }
}



// Check and start Nginx if needed
if(getProcessIdByPort($nginxPort) !== null){
    $response['nginx_running'] = true;
    $response['nginx_message'] = 'Nginx server is already running.';
} else {
    $nginxDir = dirname($nginxPath);
    // Construct the command to start Nginx.
    // 'start /B' runs the command in the background without creating a new window.
    // The first "" is a placeholder for the title of the new window (irrelevant for /B).
    // escapeshellarg is used for security and to handle paths with spaces.
    // -p specifies the prefix path for Nginx (where it expects conf, logs, etc.).
    $startNginxCmd = sprintf(
        'start /B "" %s -p %s',
        escapeshellarg($nginxPath), // Path to nginx.exe
        escapeshellarg($nginxDir)   // Prefix path (directory containing nginx.exe)
    );

    $nginx_exec_output_data = [];
    $nginx_exec_return_var_data = -1; // Default to error
    
    // Execute the command to start Nginx
    exec($startNginxCmd, $nginx_exec_output_data, $nginx_exec_return_var_data);
    
    $response['nginx_exec_output'] = $nginx_exec_output_data; // Output from 'start' command
    $response['nginx_exec_return_var'] = $nginx_exec_return_var_data; // Return code of 'start' command

    usleep(1000000); // Wait 1 second for Nginx to initialize

    if (getProcessIdByPort($nginxPort) !== null) {
        $response['nginx_running'] = true;
        $response['nginx_started'] = true;
        $response['nginx_message'] = 'Nginx server started successfully.';
    } else {
        $response['nginx_message'] = 'Failed to start Nginx server.';
    }

    if ($nginx_exec_return_var_data !== 0) {
        $response['nginx_message'] .= "The command to start Nginx ('start /B ...') might have failed (return code: " . $nginx_exec_return_var_data . "). ";
    }
    $response['nginx_message'] .= "Check Nginx error logs (usually in 'logs/error.log' relative to Nginx executable). Ensure Nginx configuration is correct, paths are valid, PHP has permission to execute Nginx, and Nginx has permission to write its log/pid files.";
    
}

// Output result as JSON
header('Content-Type: application/json');
echo json_encode($response, JSON_PRETTY_PRINT);
