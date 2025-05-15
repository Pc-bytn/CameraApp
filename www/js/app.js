// --- WebRTC Globals ---
let localStream;
let peerConnection;
const webSocketSignalingUrl = "WEBSOCKET_PRIVATE_URL"; // Placeholder: e.g., ws://yourserver.com:8080 or wss://yourserver.com/ws
let sessionId; // To identify this specific WebRTC session
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let isReconnecting = false;
let keepAliveIntervalId;
let websocket; // WebSocket connection
let iceCandidateBuffer = [];
let answerReceived = false;

const peerConnectionConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10
};

function generateUniqueId() {
    return Math.random().toString(36).substring(2, 15);
}

function sendSignalingMessage(message) {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        message.sessionId = sessionId;
        message.origin = 'initiator';
        websocket.send(JSON.stringify(message));
        console.log('Signaling message sent via WebSocket:', message.type);
        return true;
    } else {
        alert('WebSocket is not connected. Cannot send message.');
        console.error('WebSocket not connected, cannot send message:', message.type);
        return false;
    }
}

// --- Ensure WebSocket is open before sending offer ---
function connectWebSocket(onOpenCallback) {
    if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
        console.log('WebSocket already connected or connecting.');
        if (websocket.readyState === WebSocket.OPEN && typeof onOpenCallback === 'function') {
            onOpenCallback();
        }
        return;
    }

    websocket = new WebSocket(webSocketSignalingUrl);

    websocket.onopen = () => {
        console.log('WebSocket connection established.');
        websocket.send(JSON.stringify({
            type: 'register',
            sessionId: sessionId,
            peerType: 'initiator'
        }));

        if (keepAliveIntervalId) clearInterval(keepAliveIntervalId);
        keepAliveIntervalId = setInterval(() => {
            if (websocket && websocket.readyState === WebSocket.OPEN) {
                sendSignalingMessage({ type: 'ping' });
                console.log('Sending ping (initiator)');
            }
        }, 25000);

        // Only call onOpenCallback after WebSocket is fully open
        if (typeof onOpenCallback === 'function') {
            onOpenCallback();
        }
    };

    websocket.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        console.log('Received WebSocket message (initiator):', message);

        if (!peerConnection && message.type !== 'hangup' && message.type !== 'pong') {
        }

        switch (message.type) {
            case 'answer':
                if (peerConnection && peerConnection.signalingState === 'have-local-offer') {
                    try {
                        console.log('Received answer from viewer, setting remote description...');
                        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
                        console.log('Remote description (answer) set successfully.');
                        // Now the viewer is present, send all buffered ICE candidates
                        answerReceived = true;
                        if (iceCandidateBuffer.length > 0) {
                            console.log(`Sending ${iceCandidateBuffer.length} buffered ICE candidates after answer.`);
                            iceCandidateBuffer.forEach(candidate => {
                                sendSignalingMessage({
                                    type: 'candidate',
                                    candidate: candidate,
                                    sessionId,
                                    origin: 'initiator'
                                });
                            });
                            iceCandidateBuffer = [];
                            console.log('Sent all buffered ICE candidates after answer.');
                        }
                    } catch (error) {
                        console.error('Error setting remote description:', error);
                        alert('Error establishing connection with viewer: ' + error.message);
                    }
                } else {
                    console.warn('Received answer but peerConnection state is not "have-local-offer" or peerConnection is null. Current state:', peerConnection ? peerConnection.signalingState : 'null');
                }
                break;
            case 'candidate':
                if (peerConnection && message.candidate) {
                    if (peerConnection.remoteDescription) {
                        try {
                            await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
                            console.log('Added remote ICE candidate (initiator).');
                        } catch (e) {
                            console.error('Error adding received ICE candidate (initiator):', e);
                        }
                    } else {
                        console.warn('Received ICE candidate (initiator) but remote description not set yet.');
                    }
                }
                break;
            case 'pong':
                console.log('Received pong from server (initiator) - connection alive');
                break;
            case 'request_ice_restart':
                console.log('Received ICE restart request from viewer');
                if (peerConnection) {
                    alert('Attempting to reconnect to viewer...');
                    // Recreate the offer with iceRestart flag to force new ICE candidates
                    isReconnecting = true;
                    createAndSendOffer();
                }
                break;
            case 'recovery_timeout':
                console.log('Recovery timeout notification from viewer');
                alert('Reconnection attempt timed out. Stream may be unreliable.');
                break;
            case 'hangup':
                console.log('Received hangup from viewer/server (initiator)');
                stopWebRTCStream(false);
                break;
            case 'error':
                alert(`Server error: ${message.message}`);
                console.error('Server error message:', message.message);
                break;
        }
    };

    websocket.onerror = (error) => {
        console.error('WebSocket error (initiator):', error);
        alert('WebSocket connection error. Please try again.');
        updateCaptureButtonState(false);
    };

    websocket.onclose = (event) => {
        console.log('WebSocket connection closed (initiator):', event.reason, `Code: ${event.code}`);
        if (keepAliveIntervalId) clearInterval(keepAliveIntervalId);
        if (peerConnection && peerConnection.iceConnectionState !== 'closed') {
        }
        updateCaptureButtonState(false);
    };
}

function updateCaptureButtonState(isStreaming) {
    const captureBtn = document.getElementById('capture-btn');
    if (isStreaming) {
        captureBtn.classList.add('streaming');
    } else {
        captureBtn.classList.remove('streaming');
    }
}

// --- Only allow offer sending after WebSocket is open ---
async function startWebRTCStream() {
    if (peerConnection && peerConnection.iceConnectionState !== 'closed' && peerConnection.iceConnectionState !== 'failed') {
        alert('A stream is already active or attempting to connect.');
        return;
    }

    updateCaptureButtonState(true);

    alert('Starting WebRTC stream setup...');
    reconnectAttempts = 0;
    isReconnecting = false;

    try {
        await ensureCameraPermissions();
        await checkCameraAvailability();
        await initializeMediaStream();

        if (!sessionId) {
            sessionId = generateUniqueId();
            console.log('Generated new Session ID:', sessionId);
        }

        // Only setup peer connection after WebSocket is open
        connectWebSocket(() => {
            if (websocket && websocket.readyState === WebSocket.OPEN) {
                setupPeerConnection();
            } else {
                alert('WebSocket not ready. Please try again.');
                updateCaptureButtonState(false);
            }
        });

    } catch (e) {
        alert('Error starting WebRTC stream: ' + e.message);
        console.error('WebRTC Start Error:', e);
        stopWebRTCStream();
    }
}

async function initializeMediaStream() {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const constraints = {
            video: {
                width: { ideal: 1280, min: 640 },
                height: { ideal: 720, min: 480 },
                facingMode: 'environment'
            },
            audio: true
        };

        try {
            console.log('Attempting to access media with constraints:', JSON.stringify(constraints));

            if (window.cordova &&
                device &&
                device.platform === "Android" &&
                parseInt(device.version) >= 13) {
                await checkAndroidCamera13Permissions();
            }

            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log('Successfully obtained media stream');

            const videoElement = document.getElementById('local-video');
            if (videoElement) {
                videoElement.srcObject = localStream;
            }

        } catch (mediaError) {
            console.error('Initial getUserMedia error:', mediaError);

            try {
                alert('Trying video-only access... Error: ' + mediaError.message);
                console.log('Falling back to video-only constraints');
                localStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: false
                });
                console.log('Successfully obtained video-only stream');

                try {
                    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    const audioTrack = audioStream.getAudioTracks()[0];
                    localStream.addTrack(audioTrack);
                    console.log('Successfully added audio track to stream');
                } catch (audioError) {
                    console.warn('Could not add audio to stream:', audioError);
                }

            } catch (videoError) {
                try {
                    alert('Trying simplified camera access... Error: ' + videoError.message);
                    console.log('Falling back to minimal constraints');

                    const constraints = {
                        video: {
                            width: { ideal: 640, min: 320 },
                            height: { ideal: 480, min: 240 },
                            frameRate: { max: 15 }
                        }
                    };

                    localStream = await navigator.mediaDevices.getUserMedia(constraints);
                    console.log('Successfully obtained media stream with minimal constraints');
                } catch (fallbackError) {
                    console.error('Fallback getUserMedia error:', fallbackError);
                    try {
                        const devices = await navigator.mediaDevices.enumerateDevices();
                        const videoDevices = devices.filter(device => device.kind === 'videoinput');

                        if (videoDevices.length > 0) {
                            const constraints = {
                                video: {
                                    deviceId: { exact: videoDevices[0].deviceId },
                                    width: { ideal: 640 },
                                    height: { ideal: 480 }
                                }
                            };

                            localStream = await navigator.mediaDevices.getUserMedia(constraints);
                            console.log('Successfully obtained stream using specific device ID');
                        } else {
                            const errorMsg = 'No cameras detected on this device';
                            alert(errorMsg);
                            throw new Error(errorMsg);
                        }
                    } catch (finalError) {
                        const errorMsg = 'Camera access error: ' + finalError.name + ': ' + finalError.message;
                        alert(errorMsg);
                        throw new Error('Could not access camera: ' + finalError.message);
                    }
                }
            }
        }
    } else {
        throw new Error('MediaDevices API not supported in this browser');
    }
}

function stopWebRTCStream(notifyServer = true) {
    if (keepAliveIntervalId) {
        clearInterval(keepAliveIntervalId);
        keepAliveIntervalId = null;
    }

    if (notifyServer && sessionId && websocket && websocket.readyState === WebSocket.OPEN) {
        sendSignalingMessage({ type: 'hangup' });
        console.log('Sent hangup message via WebSocket.');
    }

    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
            console.log(`Stopped ${track.kind} track`);
        });
        localStream = null;
    }

    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    if (websocket) {
        if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
            websocket.close();
        }
        websocket = null;
    }

    updateCaptureButtonState(false);

    alert('Stream stopped.');
    sessionId = null;

    const videoElement = document.getElementById('local-video');
    if (videoElement) {
        videoElement.srcObject = null;
    }

    isReconnecting = false;
    reconnectAttempts = 0;
}

function setupPeerConnection() {
    try {
        if (peerConnection) {
            peerConnection.close();
        }

        peerConnection = new RTCPeerConnection(peerConnectionConfig);
        console.log('Created new RTCPeerConnection');

        if (!localStream) {
            console.error('Local stream not available when setting up peer connection');
            alert('Camera stream not available. Please restart the capture.');
            return;
        }

        // Log stream details to help with debugging
        console.log(`Local stream has ${localStream.getTracks().length} tracks`);
        localStream.getTracks().forEach(track => {
            console.log(`Adding track to PeerConnection: ${track.kind}, enabled: ${track.enabled}, muted: ${track.muted}`);
            const sender = peerConnection.addTrack(track, localStream);
            if (sender) {
                console.log('Track added successfully to peer connection');
            } else {
                console.warn('Failed to add track to peer connection');
            }
        });

        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                if (!answerReceived) {
                    // Buffer ICE candidates until answer is received
                    iceCandidateBuffer.push(event.candidate);
                    console.log('Buffered ICE candidate (waiting for viewer/answer)');
                } else {
                    sendSignalingMessage({
                        type: 'candidate',
                        candidate: event.candidate,
                        sessionId,
                        origin: 'initiator'
                    });
                }
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            console.log(`ICE connection state (initiator): ${peerConnection.iceConnectionState}`);
            if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
                alert('Stream connected successfully!');
                reconnectAttempts = 0;
                isReconnecting = false;
            } else if (peerConnection.iceConnectionState === 'failed') {
                handleConnectionFailure();
            } else if (peerConnection.iceConnectionState === 'disconnected') {
                alert('Stream temporarily disconnected. Attempting to recover...');
            } else if (peerConnection.iceConnectionState === 'closed') {
                alert('Stream closed.');
                stopWebRTCStream(false);
            }
        };

        peerConnection.onsignalingstatechange = () => {
            console.log(`Signaling state: ${peerConnection.signalingState}`);
        };

        // Reset buffer and flag
        iceCandidateBuffer = [];
        answerReceived = false;
        createAndSendOffer();
    } catch (error) {
        console.error('Error setting up peer connection:', error);
        alert('Failed to setup WebRTC connection: ' + error.message);
        throw error;
    }
}

async function handleConnectionFailure() {
    if (isReconnecting) return;

    isReconnecting = true;

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        alert(`Connection lost. Attempting to reconnect... (Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

        try {
            if (peerConnection && peerConnection.signalingState !== 'closed') {
                // Use ICE restart instead of recreating the connection if possible
                console.log('Attempting ICE restart');
                createAndSendOffer();
                
                // Set a timeout for this reconnection attempt
                setTimeout(() => {
                    if (isReconnecting && peerConnection && 
                        (peerConnection.iceConnectionState === 'disconnected' || 
                         peerConnection.iceConnectionState === 'failed')) {
                        console.log(`Reconnection attempt ${reconnectAttempts} timed out`);
                        
                        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                            alert('Failed to reconnect after multiple attempts.');
                            stopWebRTCStream();
                        } else {
                            // Try a more aggressive approach with a new peer connection
                            if (peerConnection) {
                                peerConnection.close();
                                peerConnection = null;
                            }
                            setupPeerConnection();
                        }
                    }
                }, 10000); // 10 second timeout for reconnection attempt
            } else {
                // PeerConnection is already closed, create a new one
                if (peerConnection) {
                    peerConnection.close();
                    peerConnection = null;
                }
                setupPeerConnection();
            }
        } catch (e) {
            console.error('Reconnection attempt failed:', e);
            setTimeout(() => {
                isReconnecting = false;
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    handleConnectionFailure();
                } else {
                    alert('Failed to reconnect after multiple attempts.');
                    stopWebRTCStream();
                }
            }, 3000);
        }
    } else {
        alert('Failed to reconnect after multiple attempts.');
        stopWebRTCStream();
    }
}

async function createAndSendOffer() {
    try {
        if (!peerConnection) {
            console.error("Cannot create offer: PeerConnection does not exist.");
            return;
        }
        
        console.log(`Creating offer with iceRestart: ${isReconnecting}`);
        const offerOptions = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        };
        
        // Add iceRestart flag when reconnecting to force new ICE candidates
        if (isReconnecting) {
            offerOptions.iceRestart = true;
        }
        
        const offer = await peerConnection.createOffer(offerOptions);
        await peerConnection.setLocalDescription(offer);

        if (!sessionId) {
            console.error("Session ID is not set. Cannot send offer.");
            return;
        }

        console.log('Local description (offer) set. Sending offer...');
        const success = sendSignalingMessage({ type: 'offer', offer: offer });
        if (!success) {
            alert('Failed to send offer. WebSocket not ready or error occurred.');
        } else {
            // Reset reconnecting flag only after a successful reconnection
            if (peerConnection.iceConnectionState === 'connected' || 
                peerConnection.iceConnectionState === 'completed') {
                isReconnecting = false;
            }
            
            // Send notification to viewer that we're attempting recovery
            if (isReconnecting) {
                sendSignalingMessage({ type: 'recovery_attempt' });
            }
        }
    } catch (error) {
        console.error('Error creating or sending offer:', error);
        alert('Failed to create or send offer: ' + error.message);
        stopWebRTCStream();
    }
}

async function shareSessionLink() {
    if (!sessionId) {
        alert('Please start the stream first to get a session ID.');
        return;
    }

    try {
        const wsUrlObj = new URL(webSocketSignalingUrl);
        const viewerPageUrl = `${wsUrlObj.protocol === 'wss:' ? 'https:' : 'http:'}//PRIVATE_WEB_URL/sys/viewer.html?sessionId=${sessionId}`;

        alert(`Share this link with the viewer: ${viewerPageUrl}`);

        if (navigator.share) {
            await navigator.share({ title: 'Stream Link', text: 'Join my stream:', url: viewerPageUrl });
            console.log('Stream link shared successfully.');
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
            try {
                await navigator.clipboard.writeText(viewerPageUrl);
                alert('Stream link copied to clipboard!');
                console.log('Link copied to clipboard');
            } catch (clipboardError) {
                // Fallback to prompt if clipboard fails (e.g., permission denied)
                prompt('Copy this link to share the stream:', viewerPageUrl);
                alert('Clipboard write failed. Please copy the link manually.');
                console.warn('Clipboard write error:', clipboardError);
            }
        } else {
            prompt('Please copy this link to share the stream:', viewerPageUrl);
        }
    } catch (error) {
        alert('Error sharing session link: ' + error.message);
        console.error('Share error:', error);
    }
}

function onDeviceReady() {
    console.log('Device ready event fired');

    if (!window.device) {
        console.warn('Device plugin not available - some Android 13+ specific features may not work correctly');
    } else {
        console.log(`Device platform: ${device.platform}, version: ${device.version}`);
    }

    updateCaptureButtonState(false);

    requestCameraPermission();

    document.getElementById('capture-btn').addEventListener('click', function() {
        if (!peerConnection || peerConnection.iceConnectionState === 'closed' || peerConnection.iceConnectionState === 'failed') {
            startWebRTCStream();
        } else {
            stopWebRTCStream();
        }
    });

    document.getElementById('send-btn').addEventListener('click', shareSessionLink);
}

function requestCameraPermission() {
    if (cordova.plugins && cordova.plugins.permissions) {
        const permissions = cordova.plugins.permissions;
        permissions.checkPermission(permissions.CAMERA, function(status) {
            if (!status.hasPermission) {
                permissions.requestPermission(permissions.CAMERA, function(status) {
                    if (!status.hasPermission) {
                        alert('Camera permission is required to use this app.');
                    }
                }, function() {
                    alert('Camera permission is required to use this app.');
                });
            }
        }, function() {
            alert('Error checking camera permission.');
        });
    } else {
        console.warn('Cordova Permissions plugin not available');
    }
}

function checkCameraAvailability() {
    return new Promise((resolve, reject) => {
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
            navigator.mediaDevices.enumerateDevices()
                .then(devices => {
                    const videoDevices = devices.filter(device => device.kind === 'videoinput');
                    if (videoDevices.length > 0) {
                        console.log('Found video devices:', videoDevices.length);
                        resolve(true);
                    } else {
                        console.warn('No video input devices found');
                        reject(new Error('No camera detected on this device'));
                    }
                })
                .catch(err => {
                    console.error('Error enumerating devices:', err);
                    reject(err);
                });
        } else {
            console.warn('mediaDevices.enumerateDevices not supported');
            resolve(true);
        }
    });
}

function checkAndroidCamera13Permissions() {
    return new Promise((resolve, reject) => {
        if (window.cordova && cordova.plugins && cordova.plugins.permissions) {
            const permissions = cordova.plugins.permissions;

            if (device && device.platform === "Android" && parseInt(device.version) >= 13) {
                console.log("Checking Android 13+ specific camera permissions...");

                const requiredPermissions = [
                    permissions.CAMERA,
                    permissions.RECORD_AUDIO,
                    permissions.MODIFY_AUDIO_SETTINGS,
                    permissions.READ_MEDIA_IMAGES || "android.permission.READ_MEDIA_IMAGES",
                    permissions.READ_MEDIA_VIDEO || "android.permission.READ_MEDIA_VIDEO"
                ];

                function requestNextPermission(index) {
                    if (index >= requiredPermissions.length) {
                        console.log("All Android 13+ permissions checked.");
                        resolve();
                        return;
                    }

                    const permission = requiredPermissions[index];
                    if (!permission) {
                        requestNextPermission(index + 1);
                        return;
                    }

                    permissions.checkPermission(permission, status => {
                        if (status.hasPermission) {
                            console.log(`Permission ${permission} already granted`);
                            requestNextPermission(index + 1);
                        } else {
                            console.log(`Requesting permission ${permission}`);
                            permissions.requestPermission(permission, status => {
                                if (status.hasPermission) {
                                    console.log(`Permission ${permission} granted`);
                                } else {
                                    console.log(`Permission ${permission} denied`);
                                }
                                requestNextPermission(index + 1);
                            }, error => {
                                console.warn(`Error requesting permission ${permission}:`, error);
                                requestNextPermission(index + 1);
                            });
                        }
                    }, error => {
                        console.warn(`Error checking permission ${permission}:`, error);
                        requestNextPermission(index + 1);
                    });
                }

                requestNextPermission(0);
            } else {
                resolve();
            }
        } else {
            resolve();
        }
    });
}

function ensureCameraPermissions() {
    return new Promise((resolve, reject) => {
        if (window.cordova && cordova.plugins && cordova.plugins.permissions) {
            const permissions = cordova.plugins.permissions;

            const requiredPermissions = [
                permissions.CAMERA,
                permissions.RECORD_AUDIO,
                permissions.MODIFY_AUDIO_SETTINGS
            ];

            if (device && device.platform === "Android" && parseInt(device.version) >= 13) {
                if (permissions.READ_MEDIA_IMAGES) {
                    requiredPermissions.push(permissions.READ_MEDIA_IMAGES);
                }
                if (permissions.READ_MEDIA_VIDEO) {
                    requiredPermissions.push(permissions.READ_MEDIA_VIDEO);
                }
            }

            function checkAndRequestPermission(permissionIndex) {
                if (permissionIndex >= requiredPermissions.length) {
                    resolve();
                    return;
                }

                const permission = requiredPermissions[permissionIndex];
                if (!permission) {
                    checkAndRequestPermission(permissionIndex + 1);
                    return;
                }

                permissions.checkPermission(permission, status => {
                    if (status.hasPermission) {
                        checkAndRequestPermission(permissionIndex + 1);
                    } else {
                        permissions.requestPermission(permission, status => {
                            if (status.hasPermission) {
                                checkAndRequestPermission(permissionIndex + 1);
                            } else {
                                console.error(`Permission ${permission} denied`);
                                if (permission === permissions.CAMERA) {
                                    reject(new Error('Camera permission not granted - required for this app'));
                                } else {
                                    checkAndRequestPermission(permissionIndex + 1);
                                }
                            }
                        }, error => {
                            console.error(`Error requesting permission ${permission}:`, error);
                            if (permission === permissions.CAMERA) {
                                reject(new Error('Error requesting camera permission: ' + error));
                            } else {
                                checkAndRequestPermission(permissionIndex + 1);
                            }
                        });
                    }
                }, error => {
                    console.error(`Error checking permission ${permission}:`, error);
                    if (permission === permissions.CAMERA) {
                        reject(new Error('Error checking camera permission: ' + error));
                    } else {
                        checkAndRequestPermission(permissionIndex + 1);
                    }
                });
            }

            checkAndRequestPermission(0);
        } else {
            console.log('Not using Cordova permissions plugin, assuming permissions granted');
            resolve();
        }
    });
}

document.addEventListener('deviceready', onDeviceReady, false);