<?php
// filepath: c:\Projects\Cordova_Projects\CameraApp\serverfiles\signaling.php
// This file is now a WebSocket server using Ratchet.
// You need to install Ratchet: `composer require cboden/ratchet`
// Run this script from CLI: `php c:/Projects/Cordova_Projects/CameraApp/serverfiles/signaling.php`

// Important: Ensure your PHP CLI has the necessary extensions (e.g., sockets).
// This server needs to run persistently. Use a process manager like Supervisor in production.
// Configure your web server (Apache/Nginx) to proxy WebSocket connections to this server if needed (e.g., for wss://).

ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

//die(__DIR__.'/vendor/autoload.php');
require __DIR__ . '/vendor/autoload.php'; // Adjust path to autoload.php based on your project structure

use Ratchet\MessageComponentInterface;
use Ratchet\ConnectionInterface;
use Ratchet\Server\IoServer;
use Ratchet\Http\HttpServer;
use Ratchet\WebSocket\WsServer;

class SignalingServer implements MessageComponentInterface {
    protected $clients;
    private $sessions; // [sessionId => [peerType => connection, ...]]

    public function __construct() {
        $this->clients = new \SplObjectStorage;
        $this->sessions = [];
        echo "WebSocket Signaling Server started\n";
    }

    public function onOpen(ConnectionInterface $conn) {
        $this->clients->attach($conn);
        echo "New connection! ({$conn->resourceId})\n";
    }

    public function onMessage(ConnectionInterface $from, $msg) {
        $numRecv = count($this->clients) - 1;
        echo sprintf('Connection %d sending message "%s" to %d other connection%s' . "\n", $from->resourceId, $msg, $numRecv, $numRecv == 1 ? '' : 's');

        $data = json_decode($msg, true);

        if (!$data || !isset($data['type'])) {
            echo "Invalid message format: {$msg}\n";
            $from->send(json_encode(['type' => 'error', 'message' => 'Invalid message format']));
            return;
        }

        $sessionId = $data['sessionId'] ?? null;

        switch ($data['type']) {
            case 'register':
                if (!$sessionId || !isset($data['peerType'])) {
                    $from->send(json_encode(['type' => 'error', 'message' => 'SessionId and peerType required for registration.']));
                    return;
                }
                $peerType = $data['peerType']; // 'initiator' or 'viewer'
                
                if (!isset($this->sessions[$sessionId])) {
                    $this->sessions[$sessionId] = [];
                }
                $this->sessions[$sessionId][$peerType] = $from;
                // Store peerType on the connection object itself for easier lookup on close/error
                $from->sessionId = $sessionId;
                $from->peerType = $peerType;

                echo "Registered peer {$peerType} for session {$sessionId} (Conn: {$from->resourceId})\n";
                $from->send(json_encode(['type' => 'registered', 'sessionId' => $sessionId, 'peerType' => $peerType]));

                // If viewer registers and initiator has already sent an offer, forward it.
                // This part is simplified; a more robust solution might queue offers.
                if ($peerType === 'viewer' && isset($this->sessions[$sessionId]['initiator_offer'])) {
                    $offerData = $this->sessions[$sessionId]['initiator_offer'];
                    echo "Forwarding stored offer to viewer for session {$sessionId}\n";
                    $from->send(json_encode($offerData));
                    // unset($this->sessions[$sessionId]['initiator_offer']); // Clear after sending
                }
                // If initiator registers and viewer is waiting for offer (less common flow here)
                // Or if both are registered, initiator can now send offer.
                break;

            case 'offer':
                if (!$sessionId || !isset($data['offer'])) {
                     $from->send(json_encode(['type' => 'error', 'message' => 'SessionId and offer data required.'])); return;
                }
                echo "Received offer for session {$sessionId} from initiator (Conn: {$from->resourceId})\n";
                // Store offer in case viewer is not yet connected or ready
                // $this->sessions[$sessionId]['initiator_offer'] = $data;

                // Forward to viewer if connected
                if (isset($this->sessions[$sessionId]['viewer'])) {
                    $viewerConn = $this->sessions[$sessionId]['viewer'];
                    echo "Forwarding offer to viewer (Conn: {$viewerConn->resourceId}) for session {$sessionId}\n";
                    $viewerConn->send($msg); // Forward the original message
                } else {
                    echo "Viewer not yet connected for session {$sessionId}. Storing offer.\n";
                    // Store the offer if viewer isn't there yet.
                    // This simple example assumes initiator sends offer after viewer might have registered.
                    // A more robust system would handle offer queuing better.
                    $this->sessions[$sessionId]['initiator_offer'] = $data; // Store the full message
                    $from->send(json_encode(['type' => 'info', 'message' => 'Offer received, waiting for viewer.']));
                }
                break;

            case 'answer':
            case 'candidate':
            case 'hangup':
            case 'ping': // Client sends ping, server sends pong back to that client
                if (!$sessionId) {
                    $from->send(json_encode(['type' => 'error', 'message' => 'SessionId required for message type ' . $data['type']]));
                    return;
                }
                
                $originPeerType = $from->peerType ?? ($data['origin'] ?? null); // 'initiator' or 'viewer'
                if (!$originPeerType) {
                     $from->send(json_encode(['type' => 'error', 'message' => 'Cannot determine origin peer type.'])); return;
                }

                $targetPeerType = ($originPeerType === 'initiator') ? 'viewer' : 'initiator';

                if (isset($this->sessions[$sessionId][$targetPeerType])) {
                    $targetConn = $this->sessions[$sessionId][$targetPeerType];
                    if ($data['type'] === 'ping') {
                        echo "Received ping from {$originPeerType} (Conn: {$from->resourceId}), session {$sessionId}. Sending pong.\n";
                        $from->send(json_encode(['type' => 'pong', 'sessionId' => $sessionId]));
                    } else {
                        echo "Forwarding {$data['type']} from {$originPeerType} to {$targetPeerType} for session {$sessionId}\n";
                        $targetConn->send($msg); // Forward the original message
                    }
                } else {
                    echo "Target peer {$targetPeerType} not found for session {$sessionId} to forward {$data['type']}\n";
                    if ($data['type'] !== 'ping') { // Don't send error for ping if target is missing
                        $from->send(json_encode(['type' => 'error', 'message' => "Peer {$targetPeerType} not connected for session {$sessionId}"]));
                    }
                }
                break;
            
            case 'request_ice_restart': // Viewer requests initiator to restart ICE
                 if (!$sessionId) { $from->send(json_encode(['type' => 'error', 'message' => 'SessionId required.'])); return; }
                 if (isset($this->sessions[$sessionId]['initiator'])) {
                    echo "Viewer requested ICE restart for session {$sessionId}. Notifying initiator.\n";
                    $this->sessions[$sessionId]['initiator']->send(json_encode(['type' => 'ice_restart_request', 'sessionId' => $sessionId]));
                 }
                break;

            default:
                echo "Unknown message type: {$data['type']}\n";
                $from->send(json_encode(['type' => 'error', 'message' => 'Unknown message type: ' . $data['type']]));
                break;
        }
    }

    public function onClose(ConnectionInterface $conn) {
        $this->clients->detach($conn);
        echo "Connection {$conn->resourceId} has disconnected\n";

        // Clean up session data for this connection
        $sessionId = $conn->sessionId ?? null;
        $peerType = $conn->peerType ?? null;

        if ($sessionId && $peerType && isset($this->sessions[$sessionId][$peerType])) {
            if ($this->sessions[$sessionId][$peerType] === $conn) {
                unset($this->sessions[$sessionId][$peerType]);
                echo "Unregistered {$peerType} for session {$sessionId}\n";

                // Notify the other peer if they are still connected
                $otherPeerType = ($peerType === 'initiator') ? 'viewer' : 'initiator';
                if (isset($this->sessions[$sessionId][$otherPeerType])) {
                    $this->sessions[$sessionId][$otherPeerType]->send(json_encode([
                        'type' => 'peer_disconnected',
                        'sessionId' => $sessionId,
                        'peerType' => $peerType
                    ]));
                    echo "Notified {$otherPeerType} about {$peerType} disconnection in session {$sessionId}\n";
                }

                if (empty($this->sessions[$sessionId])) {
                    unset($this->sessions[$sessionId]);
                    echo "Session {$sessionId} closed as no peers are left.\n";
                }
                 // If initiator disconnects, clear any stored offer
                if ($peerType === 'initiator' && isset($this->sessions[$sessionId]['initiator_offer'])) {
                    unset($this->sessions[$sessionId]['initiator_offer']);
                }
            }
        }
    }

    public function onError(ConnectionInterface $conn, \Exception $e) {
        echo "An error has occurred: {$e->getMessage()}\n";
        // Log detailed error: $e->getTraceAsString()

        // Clean up session data for this connection as onError might be followed by onClose or might not.
        $sessionId = $conn->sessionId ?? null;
        $peerType = $conn->peerType ?? null;
        if ($sessionId && $peerType && isset($this->sessions[$sessionId][$peerType])) {
             if ($this->sessions[$sessionId][$peerType] === $conn) {
                unset($this->sessions[$sessionId][$peerType]);
                // Notify other peer if possible
             }
        }
        $conn->close();
    }
}

// Define the port the WebSocket server should listen on.
// Make sure this port is open in your firewall.
$port = 8099; 
// For WSS (secure WebSockets), you'd typically use a reverse proxy like Nginx or Apache
// to handle SSL termination and proxy requests to this ws:// server.

$server = IoServer::factory(
    new HttpServer(
        new WsServer(
            new SignalingServer()
        )
    ),
    $port
);

echo "Starting WebSocket server on port {$port}...\n";
$server->run();

?>
<!-- 
This PHP script is a WebSocket signaling server using Ratchet.
To use it:
1. Ensure you have Composer installed (https://getcomposer.org/).
2. Navigate to your project directory in your terminal.
3. If you don't have a composer.json file, create one: `composer init` (follow prompts).
4. Install Ratchet: `composer require cboden/ratchet`
   This will create a `vendor` directory and `composer.json`/`composer.lock` files.
5. Make sure the `require dirname(__DIR__) . '../../vendor/autoload.php';` line at the top of this script
   correctly points to your `vendor/autoload.php` file. Adjust the path if necessary.
   If this signaling.php is in `serverfiles`, and vendor is in `CameraApp` (two levels up from serverfiles, then one down to vendor):
   `require __DIR__ . '/../../vendor/autoload.php';` might be more accurate if composer.json is in CameraApp root.
   The provided path `dirname(__DIR__) . '../../vendor/autoload.php'` assumes signaling.php is in a subdirectory,
   and vendor is two levels up from that parent.
   If `CameraApp` is your project root where `vendor` is:
   `require __DIR__ . '/../vendor/autoload.php';` if signaling.php is in `serverfiles`.
   Please verify this path. A common structure:
   - CameraApp/
     - vendor/
     - serverfiles/
       - signaling.php  <-- current file
     - composer.json
   For this structure, the path should be: `require __DIR__ . '/../vendor/autoload.php';`

6. Run this script from your command line: `php c:/Projects/Cordova_Projects/CameraApp/serverfiles/signaling.php`
   (Or `php path/to/your/signaling.php`)
7. The server will start and listen on the specified port (e.g., 8080).
8. Update `webSocketSignalingUrl` in `www/js/app.js` and `serverfiles/viewer.html` to point to this server
   (e.g., `ws://your_server_ip_or_domain:8080`). If running locally for testing, `ws://localhost:8080` or `ws://127.0.0.1:8080`.
9. For production, you'll need to ensure this PHP script runs persistently (e.g., using `supervisor`)
   and that the WebSocket port is accessible. For `wss://` (secure WebSockets), you'll typically
   set up a reverse proxy (like Nginx or Apache) to handle SSL and forward to this ws:// server.

This replaces the old HTTP polling signaling.php content.
The old file-based message queue (`/webrtc_signals/` directory) is no longer used by this WebSocket server.
-->
