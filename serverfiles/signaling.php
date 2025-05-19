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
    private $sessions; // [sessionId => [peerType => connection, 'initiator_offer' => offerData, 'streamer_offer' => offerData, 'viewers' => SplObjectStorage]]

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
                $peerType = $data['peerType']; // 'initiator', 'viewer', 'host', 'streamer'
                
                if (!isset($this->sessions[$sessionId])) {
                    $this->sessions[$sessionId] = [];
                }

                if ($peerType === 'viewer') {
                    if (!isset($this->sessions[$sessionId]['viewers'])) {
                        $this->sessions[$sessionId]['viewers'] = new \SplObjectStorage();
                    }
                    $this->sessions[$sessionId]['viewers']->attach($from);
                } else {
                    if (isset($this->sessions[$sessionId][$peerType])) {
                        echo "Warning: Overwriting existing {$peerType} for session {$sessionId}\n";
                        // Consider notifying the old connection
                        // $this->sessions[$sessionId][$peerType]->send(json_encode(['type'=>'replaced']));
                        // $this->sessions[$sessionId][$peerType]->close();
                    }
                    $this->sessions[$sessionId][$peerType] = $from;
                }

                $from->sessionId = $sessionId;
                $from->peerType = $peerType;

                echo "Registered peer {$peerType} for session {$sessionId} (Conn: {$from->resourceId})\n";
                $from->send(json_encode(['type' => 'registered', 'sessionId' => $sessionId, 'peerType' => $peerType]));

                // Forward stored offers or notify relevant parties
                if ($peerType === 'host' && isset($this->sessions[$sessionId]['streamer_offer'])) {
                    $from->send(json_encode($this->sessions[$sessionId]['streamer_offer']));
                    echo "Forwarded stored streamer_offer to new host for session {$sessionId}\n";
                } elseif ($peerType === 'viewer' && isset($this->sessions[$sessionId]['initiator_offer'])) {
                    $from->send(json_encode($this->sessions[$sessionId]['initiator_offer']));
                    echo "Forwarded stored initiator_offer to new viewer for session {$sessionId}\n";
                } elseif ($peerType === 'streamer' && isset($this->sessions[$sessionId]['host'])) {
                    $this->sessions[$sessionId]['host']->send(json_encode(['type' => 'streamer_connected', 'sessionId' => $sessionId]));
                    echo "Notified host about streamer connection for session {$sessionId}\n";
                }
                break;

            case 'offer':
                if (!$sessionId || !isset($data['offer']) || !isset($data['origin'])) {
                     $from->send(json_encode(['type' => 'error', 'message' => 'SessionId, offer data, and origin required.'])); return;
                }
                $originPeerType = $data['origin']; // 'initiator' or 'streamer'
                echo "Received offer for session {$sessionId} from {$originPeerType} (Conn: {$from->resourceId})\n";

                if ($originPeerType === 'initiator') {
                    $this->sessions[$sessionId]['initiator_offer'] = $data;
                    if (isset($this->sessions[$sessionId]['viewers'])) {
                        foreach ($this->sessions[$sessionId]['viewers'] as $viewerConn) {
                            $viewerConn->send($msg);
                        }
                        echo "Forwarded initiator_offer to " . $this->sessions[$sessionId]['viewers']->count() . " viewer(s) for session {$sessionId}\n";
                    } else {
                        echo "No viewers for session {$sessionId}. Storing initiator_offer.\n";
                    }
                } elseif ($originPeerType === 'streamer') {
                    $this->sessions[$sessionId]['streamer_offer'] = $data;
                    if (isset($this->sessions[$sessionId]['host'])) {
                        $this->sessions[$sessionId]['host']->send($msg);
                        echo "Forwarded streamer_offer to host for session {$sessionId}\n";
                    } else {
                        echo "Host not connected for session {$sessionId}. Storing streamer_offer.\n";
                    }
                } else {
                    $from->send(json_encode(['type' => 'error', 'message' => 'Invalid origin for offer.']));
                }
                break;

            case 'answer': 
            case 'candidate': 
            case 'hangup':
                if (!$sessionId || !isset($data['origin'])) {
                    $from->send(json_encode(['type' => 'error', 'message' => 'SessionId and origin required for ' . $data['type']]));
                    return;
                }
                $originPeerType = $data['origin'];
                $targetPeerType = null;

                if ($originPeerType === 'initiator') $targetPeerType = 'viewers';
                else if ($originPeerType === 'viewer') $targetPeerType = 'initiator';
                else if ($originPeerType === 'streamer') $targetPeerType = 'host';
                else if ($originPeerType === 'host') $targetPeerType = 'streamer';

                if (!$targetPeerType) {
                    $from->send(json_encode(['type' => 'error', 'message' => 'Cannot determine target for origin ' . $originPeerType]));
                    return;
                }

                if ($targetPeerType === 'viewers') {
                    if (isset($this->sessions[$sessionId]['viewers']) && $this->sessions[$sessionId]['viewers']->count() > 0) {
                        echo "Forwarding {$data['type']} from {$originPeerType} to viewers for session {$sessionId}\n";
                        foreach ($this->sessions[$sessionId]['viewers'] as $viewerConn) {
                            if ($viewerConn !== $from) $viewerConn->send($msg);
                        }
                    } else {
                        echo "No viewers to forward {$data['type']} in session {$sessionId}\n";
                    }
                } elseif (isset($this->sessions[$sessionId][$targetPeerType])) {
                    $targetConn = $this->sessions[$sessionId][$targetPeerType];
                    echo "Forwarding {$data['type']} from {$originPeerType} to {$targetPeerType} for session {$sessionId}\n";
                    $targetConn->send($msg);
                } else {
                    echo "Target {$targetPeerType} not found for session {$sessionId} to forward {$data['type']}\n";
                    if ($data['type'] !== 'hangup') { // Avoid erroring on hangup if target already gone
                       // $from->send(json_encode(['type' => 'error', 'message' => "Peer {$targetPeerType} not connected."]));
                    }
                }
                break;
            
            case 'ping':
                if (!$sessionId) { $from->send(json_encode(['type' => 'error', 'message' => 'SessionId required for ping.'])); return; }
                $from->send(json_encode(['type' => 'pong', 'sessionId' => $sessionId]));
                break;

            case 'request_ice_restart':
                 if (!$sessionId || !isset($data['origin'])) { $from->send(json_encode(['type' => 'error', 'message' => 'SessionId and origin required for ICE restart.'])); return; }
                 $originPeerType = $data['origin']; 
                 $targetPeerType = null;
                 if ($originPeerType === 'viewer') $targetPeerType = 'initiator';
                 else if ($originPeerType === 'host') $targetPeerType = 'streamer';

                 if ($targetPeerType && isset($this->sessions[$sessionId][$targetPeerType])) {
                    echo "{$originPeerType} requested ICE restart. Notifying {$targetPeerType} in session {$sessionId}.\n";
                    $this->sessions[$sessionId][$targetPeerType]->send(json_encode(['type' => 'ice_restart_request', 'sessionId' => $sessionId]));
                 } else {
                    echo "Cannot process ICE restart: origin {$originPeerType}, target {$targetPeerType} invalid or not found for session {$sessionId}.\n";
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

        $sessionId = $conn->sessionId ?? null;
        $peerType = $conn->peerType ?? null;

        if ($sessionId && $peerType) {
            $notifyMessage = json_encode([
                'type' => 'peer_disconnected',
                'sessionId' => $sessionId,
                'peerType' => $peerType
            ]);

            if ($peerType === 'viewer' && isset($this->sessions[$sessionId]['viewers'])) {
                $this->sessions[$sessionId]['viewers']->detach($conn);
                echo "Unregistered viewer for session {$sessionId}\n";
                if ($this->sessions[$sessionId]['viewers']->count() === 0) {
                    unset($this->sessions[$sessionId]['viewers']);
                }
                if (isset($this->sessions[$sessionId]['initiator'])) {
                    $this->sessions[$sessionId]['initiator']->send($notifyMessage);
                }
            } elseif (isset($this->sessions[$sessionId][$peerType]) && $this->sessions[$sessionId][$peerType] === $conn) {
                unset($this->sessions[$sessionId][$peerType]);
                echo "Unregistered {$peerType} for session {$sessionId}\n";
                // Notify the other relevant peer
                $otherPeer = null;
                if ($peerType === 'initiator' && isset($this->sessions[$sessionId]['viewers'])) {
                    foreach($this->sessions[$sessionId]['viewers'] as $viewer) $viewer->send($notifyMessage);
                } elseif ($peerType === 'host' && isset($this->sessions[$sessionId]['streamer'])) {
                    $this->sessions[$sessionId]['streamer']->send($notifyMessage);
                } elseif ($peerType === 'streamer' && isset($this->sessions[$sessionId]['host'])) {
                    $this->sessions[$sessionId]['host']->send($notifyMessage);
                }
            }

            // Clear relevant offer if the offerer disconnects
            if ($peerType === 'initiator' && isset($this->sessions[$sessionId]['initiator_offer'])) {
                unset($this->sessions[$sessionId]['initiator_offer']);
            }
            if ($peerType === 'streamer' && isset($this->sessions[$sessionId]['streamer_offer'])) {
                unset($this->sessions[$sessionId]['streamer_offer']);
            }

            // Check if session is empty and can be removed
            $activePeersInSession = false;
            foreach (['initiator', 'host', 'streamer'] as $pt) {
                if (isset($this->sessions[$sessionId][$pt])) $activePeersInSession = true;
            }
            if (isset($this->sessions[$sessionId]['viewers']) && $this->sessions[$sessionId]['viewers']->count() > 0) {
                $activePeersInSession = true;
            }
            if (!$activePeersInSession && isset($this->sessions[$sessionId])) {
                unset($this->sessions[$sessionId]);
                echo "Session {$sessionId} closed.\n";
            }
        }
    }

    public function onError(ConnectionInterface $conn, \Exception $e) {
        echo "Error on connection {$conn->resourceId}: {$e->getMessage()}\n";
        // Potentially log $e->getTraceAsString();
        // Perform similar cleanup as onClose, but be cautious as state might be inconsistent
        $sessionId = $conn->sessionId ?? null;
        $peerType = $conn->peerType ?? null;
        if ($sessionId && $peerType) {
            if ($peerType === 'viewer' && isset($this->sessions[$sessionId]['viewers'])) {
                $this->sessions[$sessionId]['viewers']->detach($conn);
            } elseif (isset($this->sessions[$sessionId][$peerType]) && $this->sessions[$sessionId][$peerType] === $conn) {
                unset($this->sessions[$sessionId][$peerType]);
            }
        }
        $this->clients->detach($conn); // Ensure client is detached on error too
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
    $port,
    '0.0.0.0'
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
