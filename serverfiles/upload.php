<?php
// upload.php

header('Content-Type: application/json');

$response = ['success' => false, 'message' => 'An unknown error occurred.'];

// Check if it's a POST request
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    $response['message'] = 'Invalid request method.';
    echo json_encode($response);
    exit;
}

// Check for required POST data
if (!isset($_POST['sessionId']) || !isset($_POST['fileName']) || !isset($_FILES['mediaFile'])) {
    $response['message'] = 'Missing required data (sessionId, fileName, or mediaFile).';
    echo json_encode($response);
    exit;
}

$sessionId = $_POST['sessionId'];
$fileName  = $_POST['fileName'];
$mediaFile = $_FILES['mediaFile'];

// Validate sessionId and fileName
if (empty(trim($sessionId))) {
    $response['message'] = 'Session ID cannot be empty.';
    echo json_encode($response);
    exit;
}
if (empty(trim($fileName))) {
    $response['message'] = 'File name cannot be empty.';
    echo json_encode($response);
    exit;
}

// Sanitize session ID and file name to prevent directory traversal issues
$sessionId = basename(str_replace('..', '', $sessionId)); // More robust sanitization for session ID
$fileName  = basename(str_replace('..', '', $fileName));  // More robust sanitization for file name

// Further sanitize to prevent potentially harmful characters if used directly in paths on some systems
$sessionId = preg_replace('/[^a-zA-Z0-9_-]/', '_', $sessionId);
$fileName = preg_replace('/[^a-zA-Z0-9_.-]/', '_', $fileName);


// Check for upload errors
if ($mediaFile['error'] !== UPLOAD_ERR_OK) {
    $uploadErrors = [
        UPLOAD_ERR_INI_SIZE   => 'The uploaded file exceeds the upload_max_filesize directive in php.ini.',
        UPLOAD_ERR_FORM_SIZE  => 'The uploaded file exceeds the MAX_FILE_SIZE directive that was specified in the HTML form.',
        UPLOAD_ERR_PARTIAL    => 'The uploaded file was only partially uploaded.',
        UPLOAD_ERR_NO_FILE    => 'No file was uploaded.',
        UPLOAD_ERR_NO_TMP_DIR => 'Missing a temporary folder.',
        UPLOAD_ERR_CANT_WRITE => 'Failed to write file to disk.',
        UPLOAD_ERR_EXTENSION  => 'A PHP extension stopped the file upload.',
    ];
    $response['message'] = isset($uploadErrors[$mediaFile['error']]) ? $uploadErrors[$mediaFile['error']] : 'Unknown upload error (' . $mediaFile['error'] . ').';
    echo json_encode($response);
    exit;
}

// Define the base recording directory
// This assumes 'upload.php' is in 'serverfiles', and 'recordings' will be 'serverfiles/recordings/'
$baseDir = __DIR__ . '/recordings/'; 
$sessionDir = $baseDir . $sessionId . '/';
$targetFilePath = $sessionDir . $fileName;

// Create session-specific directory if it doesn't exist
if (!is_dir($sessionDir)) {
    // mkdir attempts to create the directory recursively.
    // Mode 0775: rwxrwxr-x (owner/group can read/write/execute, others can read/execute)
    if (!mkdir($sessionDir, 0775, true) && !is_dir($sessionDir)) { 
        $response['message'] = 'Failed to create session directory. Check server permissions for path: ' . $sessionDir;
        error_log('PHP: Failed to create directory: ' . $sessionDir);
        echo json_encode($response);
        exit;
    }
}

// Move the uploaded file to the target directory
if (move_uploaded_file($mediaFile['tmp_name'], $targetFilePath)) {
    $response['success'] = true;
    $response['message'] = 'File uploaded successfully.'; // Kept concise
    // $response['filePath'] = 'recordings/' . $sessionId . '/' . $fileName; // Client might not need this
} else {
    $response['message'] = 'Failed to move uploaded file. Check permissions or if file already exists at: ' . $targetFilePath;
    error_log('PHP: Failed to move uploaded file from ' . $mediaFile['tmp_name'] . ' to ' . $targetFilePath . '. Error: ' . print_r(error_get_last(), true));
}

echo json_encode($response);
?>
