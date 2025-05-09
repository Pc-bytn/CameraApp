<?php
// filepath: your_php_server_root/signaling.php
// WARNING: This is a very basic file-based signaling server.
// It's NOT suitable for production due to potential race conditions, no security, and inefficiency.
// Use a proper solution like WebSockets (e.g., Ratchet for PHP, or Node.js with Socket.IO) for production.

header("Access-Control-Allow-Origin: *"); // Allow all origins (restrict in production)
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

$storageDir = __DIR__ . '/webrtc_signals/'; // Make sure this directory is writable by the web server
if (!is_dir($storageDir)) {
    if (!mkdir($storageDir, 0777, true)) {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to create storage directory. Check permissions. Path: ' . $storageDir]);
        exit;
    }
}

$action = $_GET['action'] ?? null;
// Session ID can come from GET (for receive) or be part of the POST body (for send, though we also get it from query for send now)
$sessionId = $_GET['sessionId'] ?? null;
$peerType = $_GET['peer'] ?? null; // 'initiator' (Cordova app) or 'viewer' (web page)

if (!$sessionId) {
    http_response_code(400);
    echo json_encode(['error' => 'Session ID is required.']);
    exit;
}

// Sanitize session ID to prevent directory traversal and invalid characters
$sessionId = preg_replace('/[^a-zA-Z0-9_-]/', '', $sessionId);
if (empty($sessionId)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid Session ID format.']);
    exit;
}

// Define file paths based on who is sending and who should receive
// Messages FOR the initiator are stored in initiator's file, messages FOR viewer in viewer's file.
$messagesForInitiatorFile = $storageDir . $sessionId . '_to_initiator.json';
$messagesForViewerFile = $storageDir . $sessionId . '_to_viewer.json';

if ($action === 'send') {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $data = json_decode(file_get_contents('php://input'), true);
        if (!$data || !isset($data['type'])) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid data.']);
            exit;
        }
        $data['timestamp'] = time();

        // Determine target file based on message type (offer from initiator, answer from viewer)
        $targetFile = null;
        if ($data['type'] === 'offer') { // Offer from initiator, for viewer
            $targetFile = $messagesForViewerFile;
        } elseif ($data['type'] === 'answer') { // Answer from viewer, for initiator
            $targetFile = $messagesForInitiatorFile;
        } elseif ($data['type'] === 'candidate') {
            if (isset($data['origin']) && $data['origin'] === 'initiator') { // Client can add 'origin' field
                 $targetFile = $messagesForViewerFile;
            } elseif (isset($data['origin']) && $data['origin'] === 'viewer') {
                 $targetFile = $messagesForInitiatorFile;
            } else {
                if ($data['type'] === 'offer' || ($data['type'] === 'candidate' && !file_exists($messagesForInitiatorFile))) {
                    $targetFile = $messagesForViewerFile;
                } else {
                    $targetFile = $messagesForInitiatorFile;
                }
            }
        }

        if ($targetFile) {
            $messages = file_exists($targetFile) ? json_decode(file_get_contents($targetFile), true) : [];
            if (!is_array($messages)) $messages = []; // Ensure it's an array
            $messages[] = $data; // Add new message to the queue
            if (file_put_contents($targetFile, json_encode($messages), LOCK_EX)) {
                echo json_encode(['status' => 'Message queued for ' . basename($targetFile) . '.']);
            } else {
                http_response_code(500);
                echo json_encode(['error' => 'Failed to write to target file. Check permissions.']);
            }
        } else {
            http_response_code(400);
            echo json_encode(['error' => 'Could not determine target for message type: ' . $data['type']]);
        }


    } else {
        http_response_code(405);
        echo json_encode(['error' => 'POST method required for send.']);
    }
} elseif ($action === 'receive') {
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        if (!$peerType) {
            http_response_code(400);
            echo json_encode(['error' => 'Peer type (initiator/viewer) required for receive.']);
            exit;
        }

        $fileToRead = ($peerType === 'initiator') ? $messagesForInitiatorFile : $messagesForViewerFile;

        if (file_exists($fileToRead)) {
            // Read and lock
            $fileHandle = fopen($fileToRead, 'r+');
            if (flock($fileHandle, LOCK_EX)) {
                $content = fread($fileHandle, filesize($fileToRead) ?: 1); // Read content
                $messages = json_decode($content, true);

                if (!empty($messages) && is_array($messages)) {
                    $messageToSend = array_shift($messages); // Get the oldest message (FIFO)
                    ftruncate($fileHandle, 0); // Clear the file
                    rewind($fileHandle);
                    fwrite($fileHandle, json_encode($messages)); // Write remaining messages back
                    fflush($fileHandle);
                    flock($fileHandle, LOCK_UN); // Unlock
                    fclose($fileHandle);
                    echo json_encode($messageToSend);
                } else {
                    flock($fileHandle, LOCK_UN); // Unlock
                    fclose($fileHandle);
                    http_response_code(404); // No new messages
                    echo json_encode(null);
                }
            } else {
                fclose($fileHandle); // Close if lock failed
                http_response_code(500);
                echo json_encode(['error' => 'Could not lock message file for reading.']);
            }
        } else {
            http_response_code(404); // No messages yet or file doesn't exist
            echo json_encode(null);
        }
    } else {
        http_response_code(405);
        echo json_encode(['error' => 'GET method required for receive.']);
    }
} else {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid action.']);
}
?>
