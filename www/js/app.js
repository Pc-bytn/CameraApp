// --- WebRTC Globals ---
let localStream;
let peerConnection;
const signalingServerUrl = 'https://YOUR_PHP_BACKEND_URL/signaling.php'; // TODO: Replace with your actual PHP server URL
let sessionId; // To identify this specific WebRTC session

const peerConnectionConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

function generateUniqueId() {
    return Math.random().toString(36).substring(2, 15);
}

async function sendSignalingMessage(message) {
    try {
        const response = await fetch(`${signalingServerUrl}?action=send&sessionId=${message.sessionId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(message),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Signaling server error: ${response.status} ${errorText}`);
        }
        console.log('Signaling message sent:', message.type);
    } catch (e) {
        alert(`Error sending signaling message (${message.type}): ${e.message}`);
        console.error('Send signaling error:', e);
    }
}

async function listenForSignalingMessages(currentSessionId) {
    const intervalId = setInterval(async () => {
        if (!peerConnection || peerConnection.signalingState === 'closed' || peerConnection.iceConnectionState === 'closed') {
            clearInterval(intervalId);
            return;
        }
        try {
            const response = await fetch(`${signalingServerUrl}?action=receive&sessionId=${currentSessionId}&peer=initiator`);
            if (response.ok) {
                const message = await response.json();
                if (message) {
                    console.log('Received signaling message:', message);
                    if (message.type === 'answer') {
                        if (peerConnection.signalingState === 'have-local-offer') {
                            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
                            console.log('Remote description (answer) set.');
                        } else {
                            console.warn('Received answer but peerConnection state is not "have-local-offer". Current state:', peerConnection.signalingState);
                        }
                    } else if (message.type === 'candidate' && message.candidate) {
                        if (peerConnection.remoteDescription) {
                            try {
                                await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
                                console.log('Added remote ICE candidate.');
                            } catch (e) {
                                console.error('Error adding received ICE candidate:', e);
                            }
                        } else {
                            console.warn('Received ICE candidate but remote description not set yet.');
                        }
                    }
                }
            } else if (response.status !== 404) {
                console.error('Error fetching signaling messages:', response.status, await response.text());
            }
        } catch (e) {
            // console.warn('Polling error:', e.message);
        }
    }, 3000);
    return intervalId;
}

async function startWebRTCStream() {
    if (peerConnection && peerConnection.iceConnectionState !== 'closed' && peerConnection.iceConnectionState !== 'failed') {
        alert('A stream is already active or attempting to connect.');
        return;
    }
    alert('Starting WebRTC stream setup...');
    try {
        // First check if we have permission to access the camera
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            // Set constraints specifically for mobile devices
            const constraints = {
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: 'environment' // Use the back camera by default
                },
                audio: true
            };
            
            try {
                localStream = await navigator.mediaDevices.getUserMedia(constraints);
            } catch (mediaError) {
                console.error('Initial getUserMedia error:', mediaError);
                // Try with simpler constraints if the detailed ones fail
                try {
                    alert('Trying simplified camera access...');
                    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                } catch (fallbackError) {
                    console.error('Fallback getUserMedia error:', fallbackError);
                    throw new Error('Could not access camera: ' + fallbackError.message);
                }
            }
            peerConnection = new RTCPeerConnection(peerConnectionConfig);
            localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
            peerConnection.onicecandidate = event => {
                if (event.candidate) {
                    sendSignalingMessage({ type: 'candidate', candidate: event.candidate, sessionId });
                }
            };
            peerConnection.oniceconnectionstatechange = () => {
                console.log(`ICE connection state: ${peerConnection.iceConnectionState}`);
                if (peerConnection.iceConnectionState === 'connected') {
                    alert('Stream connected!');
                } else if (peerConnection.iceConnectionState === 'failed') {
                    alert('Stream connection failed. Check STUN/TURN servers and network.');
                    stopWebRTCStream();
                } else if (peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'closed') {
                    alert('Stream disconnected or closed.');
                    stopWebRTCStream();
                }
            };
            peerConnection.onsignalingstatechange = () => {
                console.log(`Signaling state: ${peerConnection.signalingState}`);
            };
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            sessionId = generateUniqueId();
            alert(`Streaming session ID: ${sessionId}\nShare this ID with the viewer.`);
            sendSignalingMessage({ type: 'offer', offer: offer, sessionId });
            listenForSignalingMessages(sessionId);        } else {
            throw new Error('MediaDevices API not supported in this browser');
        }    } catch (e) {
        alert('Error starting WebRTC stream: ' + e.message);
        console.error('WebRTC Start Error:', e);
        stopWebRTCStream();
    }
}

function stopWebRTCStream() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    alert('Stream stopped.');
    sessionId = null;
}

function onDeviceReady() {
    // Check for camera permissions on startup
    requestCameraPermission();
    
    document.getElementById('capture-btn').addEventListener('click', function() {
        if (!peerConnection || peerConnection.iceConnectionState === 'closed' || peerConnection.iceConnectionState === 'failed') {
            startWebRTCStream();
        } else {
            stopWebRTCStream();
        }
    });
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

document.addEventListener('deviceready', onDeviceReady, false);