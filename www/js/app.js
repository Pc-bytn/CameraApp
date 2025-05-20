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
let remoteAudioStream; // Stream for incoming viewer audio
let viewerAudioConnected = false; // Flag to track if viewer audio is connected

// Audio control states
let isLocalAudioMuted = false;
let isRemoteAudioMuted = false;

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

// --- Camera Facing Mode State ---
let currentFacingMode = 'environment'; // 'user' for front, 'environment' for back

// --- Camera Switch Button Handler ---
document.addEventListener('DOMContentLoaded', () => {
    const switchCamBtn = document.getElementById('switch-cam-btn');
    if (switchCamBtn) {
        switchCamBtn.addEventListener('click', async () => {
            try {
                currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';
                await switchCamera();
            } catch (e) {
                alert('Unable to switch camera: ' + (e.message || e));
            }
        });
    }
});

async function initializeMediaStream() {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const constraints = {
            video: { facingMode: { ideal: currentFacingMode } },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        };
        try {
            // Ensure any existing local stream is stopped before getting a new one
            if (localStream) {
                localStream.getTracks().forEach(track => track.stop());
            }

            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            const videoElement = document.getElementById('local-video');
            if (videoElement) {
                videoElement.srcObject = localStream;
                videoElement.muted = true; // Mute the local video element to prevent echo
                videoElement.play().catch(e => console.warn("Local video play failed (autoplay restriction likely):", e.message));
            }

            // Update local audio mute state based on the new stream's track
            const audioTrack = localStream.getAudioTracks()[0];
            isLocalAudioMuted = !audioTrack.enabled;
            updateMicrophoneButtonState();

            // Setup audio analyser for viewer audio detection
            setupAudioAnalyser(localStream);

            console.log('Local media stream initialized:', localStream);
        } catch (e) {
            // Try fallback if facingMode ideal fails
            if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') {
                try {
                    const fallbackConstraints = {
                        video: true,
                        audio: true
                    };
                    localStream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
                    const localVideo = document.getElementById('local-video');
                    if (localVideo) {
                        localVideo.srcObject = localStream;
                        localVideo.muted = true; // Mute the local video element to prevent echo
                        localVideo.play().catch(e => console.warn("Local video play failed (autoplay restriction likely):", e.message));
                    }
                } catch (err) {
                    alert('Camera not available: ' + (err.message || err));
                    throw err;
                }
            } else {
                alert('Camera error: ' + (e.message || e));
                throw e;
            }
        }
    } else {
        alert('Camera API not supported on this device.');
        throw new Error('Camera API not supported');
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
    }    // Clean up audio resources and UI
    if (remoteAudioStream) {
        remoteAudioStream.getTracks().forEach(track => {
            track.stop();
        });
        remoteAudioStream = null;
    }
    
    // Clean up audio analysis resources
    if (audioLevelCheckInterval) {
        clearInterval(audioLevelCheckInterval);
        audioLevelCheckInterval = null;
    }
    
    if (audioContext) {
        audioContext.close().catch(err => console.error('Error closing audio context:', err));
        audioContext = null;
        audioAnalyser = null;
        audioDataArray = null;
    }
      viewerAudioConnected = false;
    showAudioStatus(false);
    
    // Remove audio element if it exists
    const viewerAudio = document.getElementById('viewer-audio');
    if (viewerAudio) {
        document.body.removeChild(viewerAudio);
    }
    
    // Hide audio controls when stream is stopped
    updateAudioControlsVisibility(false);
    
    // Reset audio mute states
    isLocalAudioMuted = false;
    isRemoteAudioMuted = false;
    
    // Reset audio control button states
    updateMicrophoneButtonState();
    updateSpeakerButtonState();

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
        });        // Handle incoming tracks from viewer (for bi-directional audio)
        peerConnection.ontrack = event => {
            console.log('App: Track received:', event.track.kind, 'Stream ID:', event.streams[0] ? event.streams[0].id : "N/A");
            if (event.track.kind === 'audio') {
                if (!remoteAudioStream) {
                    remoteAudioStream = new MediaStream();
                }
                if (!remoteAudioStream.getTrackById(event.track.id)) {
                    remoteAudioStream.addTrack(event.track);
                    console.log('App: Viewer audio track added to remoteAudioStream.');
                }

                let viewerAudio = document.getElementById('viewer-audio');
                if (!viewerAudio) {
                    viewerAudio = document.createElement('audio');
                    viewerAudio.id = 'viewer-audio';
                    viewerAudio.autoplay = true;
                    // viewerAudio.controls = true; // Optional: for debugging
                    document.body.appendChild(viewerAudio); // Append to body or a specific container
                    console.log('App: Created and appended viewer audio element.');
                }

                if (viewerAudio.srcObject !== remoteAudioStream) {
                    viewerAudio.srcObject = remoteAudioStream;
                    console.log('App: Assigned remoteAudioStream to viewer audio element.');
                }

                viewerAudio.play().then(() => {
                    console.log('App: Viewer audio is playing.');
                    viewerAudioConnected = true;
                    showAudioStatus(true); // Update UI to show audio is connected
                    updateSpeakerButtonState(); // Ensure speaker button reflects current state
                }).catch(error => {
                    console.error('App: Error playing viewer audio:', error.name, error.message);
                    alert(`Error playing viewer audio: ${error.message}. Please check browser permissions and settings.`);
                    viewerAudioConnected = false;
                    showAudioStatus(false);
                });

            } else if (event.track.kind === 'video') {
                // Existing video track handling can remain here if it was separate
                // Or integrate it if it was part of a general track handler
                const videoElement = document.getElementById('local-video'); // This seems to be for local video, ensure correct target for remote
                if (event.streams && event.streams[0]) {
                    // This part might be more relevant for the viewer.html or if the app also receives video
                    // For now, focusing on audio from viewer to app.
                }
            }
        };

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
            offerToReceiveAudio: true, // Explicitly enable receiving audio from viewer
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

// --- Audio Status UI Functions ---
function showAudioStatus(show, isActive = false) {
    const audioStatusElement = document.getElementById('audio-status');
    if (!audioStatusElement) return;
    
    const statusTextElement = document.getElementById('audio-status-text');
    
    if (show && viewerAudioConnected) {
        audioStatusElement.style.display = 'flex';
        
        // Show active state if audio is currently being received
        if (isActive) {
            audioStatusElement.classList.add('active');
            if (statusTextElement) {
                statusTextElement.textContent = 'Viewer speaking...';
            }
        } else {
            audioStatusElement.classList.remove('active');
            if (statusTextElement) {
                statusTextElement.textContent = 'Viewer audio connected';
            }
        }
        
        // Fade out the notification after 5 seconds if not active
        if (!isActive) {
            setTimeout(() => {
                if (viewerAudioConnected) {
                    // Keep it visible but make it semi-transparent
                    audioStatusElement.style.opacity = '0.6';
                }
            }, 5000);
        } else {
            // Keep full opacity when active
            audioStatusElement.style.opacity = '1';
        }
    } else {
        audioStatusElement.style.display = 'none';
        audioStatusElement.style.opacity = '1';
        audioStatusElement.classList.remove('active');
    }
}

// --- Audio Analysis for Viewer Speaking Detection ---
let audioContext;
let audioAnalyser;
let audioDataArray;
let audioLevelCheckInterval;

function setupAudioAnalyser(audioStream) {
    if (!window.AudioContext && !window.webkitAudioContext) {
        console.warn('AudioContext not supported - audio level detection disabled');
        return;
    }
    
    try {
        // Cleanup existing audio analysis if any
        if (audioContext) {
            clearInterval(audioLevelCheckInterval);
            audioContext.close().catch(err => console.error('Error closing audio context:', err));
            audioContext = null;
            audioAnalyser = null;
            audioDataArray = null;
        }
        
        // Create audio context and analyser
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(audioStream);
        audioAnalyser = audioContext.createAnalyser();
        audioAnalyser.fftSize = 256;
        
        source.connect(audioAnalyser);
        
        // Create data array for analysis
        const bufferLength = audioAnalyser.frequencyBinCount;
        audioDataArray = new Uint8Array(bufferLength);
        
        // Start monitoring audio levels
        if (audioLevelCheckInterval) {
            clearInterval(audioLevelCheckInterval);
        }
        
        audioLevelCheckInterval = setInterval(checkAudioLevel, 100); // Check every 100ms
        
        console.log('Audio analyser setup complete');
    } catch (error) {
        console.error('Error setting up audio analyser:', error);
    }
}

function checkAudioLevel() {
    if (!audioAnalyser || !audioDataArray || !viewerAudioConnected) return;
    
    try {
        audioAnalyser.getByteFrequencyData(audioDataArray);
        
        // Calculate average volume level
        let sum = 0;
        for (let i = 0; i < audioDataArray.length; i++) {
            sum += audioDataArray[i];
        }
        const average = sum / audioDataArray.length;
        
        // Consider speaking if volume is above threshold (adjust as needed)
        const SPEAKING_THRESHOLD = 25;
        const isSpeaking = average > SPEAKING_THRESHOLD;
        
        // Update UI based on speaking status
        showAudioStatus(true, isSpeaking);
        
        // For debugging
        // console.log(`Audio level: ${average.toFixed(2)}`);
    } catch (error) {
        console.error('Error analyzing audio level:', error);
    }
}

// --- Device Ready and Permissions ---
function onDeviceReady() {
    console.log('Device ready event fired');

    if (!window.device) {
        console.warn('Device plugin not available - some Android 13+ specific features may not work correctly');
    } else {
        console.log(`Device platform: ${device.platform}, version: ${device.version}`);
    }

    updateCaptureButtonState(false);
    
    // Initialize audio controls visibility (hidden by default)
    updateAudioControlsVisibility(false);
    
    // Initialize audio control button states
    updateMicrophoneButtonState();
    updateSpeakerButtonState();

    requestCameraPermission();

    document.getElementById('capture-btn').addEventListener('click', function() {
        if (!peerConnection || peerConnection.iceConnectionState === 'closed' || peerConnection.iceConnectionState === 'failed') {
            startWebRTCStream();
        } else {
            stopWebRTCStream();
        }
    });

    document.getElementById('send-btn').addEventListener('click', shareSessionLink);
    
    // Add event listeners for audio control buttons
    document.getElementById('mic-toggle-btn').addEventListener('click', toggleMicrophone);
    document.getElementById('speaker-toggle-btn').addEventListener('click', toggleSpeaker);
}

// --- Audio Control Functions ---
function toggleMicrophone() {
    if (!localStream) {
        alert('Camera stream not initialized yet.');
        return;
    }
    
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) {
        alert('No microphone found or microphone access denied.');
        return;
    }
    
    isLocalAudioMuted = !isLocalAudioMuted;
    audioTrack.enabled = !isLocalAudioMuted;
    
    // Update UI
    updateMicrophoneButtonState();
    
    // Show notification
    alert(isLocalAudioMuted ? 'Microphone muted' : 'Microphone unmuted');
    console.log(`Local microphone ${isLocalAudioMuted ? 'muted' : 'unmuted'}`);
}

function toggleSpeaker() {
    if (!remoteAudioStream) {
        alert('No viewer audio connected yet.');
        return;
    }
    
    const viewerAudio = document.getElementById('viewer-audio');
    if (!viewerAudio) {
        alert('Viewer audio element not found.');
        return;
    }
    
    isRemoteAudioMuted = !isRemoteAudioMuted;
    viewerAudio.muted = isRemoteAudioMuted;
    
    // Update UI
    updateSpeakerButtonState();
    
    // Show notification
    alert(isRemoteAudioMuted ? 'Viewer audio muted' : 'Viewer audio unmuted');
    console.log(`Remote audio ${isRemoteAudioMuted ? 'muted' : 'unmuted'}`);
}

function updateMicrophoneButtonState() {
    const micToggleBtn = document.getElementById('mic-toggle-btn');
    const micOnIcon = micToggleBtn.querySelector('.mic-on');
    const micOffIcon = micToggleBtn.querySelector('.mic-off');
    
    if (isLocalAudioMuted) {
        micToggleBtn.classList.add('muted');
        micOnIcon.style.display = 'none';
        micOffIcon.style.display = 'block';
    } else {
        micToggleBtn.classList.remove('muted');
        micOnIcon.style.display = 'block';
        micOffIcon.style.display = 'none';
    }
}

function updateSpeakerButtonState() {
    const speakerToggleBtn = document.getElementById('speaker-toggle-btn');
    const speakerOnIcon = speakerToggleBtn.querySelector('.speaker-on');
    const speakerOffIcon = speakerToggleBtn.querySelector('.speaker-off');
    
    if (isRemoteAudioMuted) {
        speakerToggleBtn.classList.add('muted');
        speakerOnIcon.style.display = 'none';
        speakerOffIcon.style.display = 'block';
    } else {
        speakerToggleBtn.classList.remove('muted');
        speakerOnIcon.style.display = 'block';
        speakerOffIcon.style.display = 'none';
    }
}

// Function to update the visibility of audio control buttons
function updateAudioControlsVisibility(show) {
    const audioControls = document.querySelector('.audio-controls');
    if (!audioControls) return;
    
    if (show) {
        audioControls.style.display = 'flex';
    } else {
        audioControls.style.display = 'none';
    }
}

// --- Camera Permissions and Initialization ---
function requestCameraPermission() {
    if (cordova.plugins && cordova.plugins.permissions) {
        const permissions = cordova.plugins.permissions;
        
        // Check and request camera permission
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
        
        // Also check and request microphone permission for bi-directional audio
        permissions.checkPermission(permissions.RECORD_AUDIO, function(status) {
            if (!status.hasPermission) {
                permissions.requestPermission(permissions.RECORD_AUDIO, function(status) {
                    if (!status.hasPermission) {
                        alert('Microphone permission is required for audio communication.');
                    }
                }, function() {
                    alert('Microphone permission is required for audio communication.');
                });
            }
        }, function() {
            alert('Error checking microphone permission.');
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

            // Make sure we request all necessary permissions for bi-directional audio
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

// --- Function to switch camera while maintaining WebRTC connection ---
async function switchCamera() {
    if (!localStream) {
        console.warn('No local stream available to switch camera.');
        alert('Camera stream not available. Please start the stream first.');
        return;
    }

    // Get current video track
    const currentVideoTrack = localStream.getVideoTracks()[0];
    if (!currentVideoTrack) {
        console.warn('No video track in local stream.');
        return;
    }

    // Check the current facing mode
    let isFrontCamera;
    try {
        isFrontCamera = currentVideoTrack.getSettings().facingMode === 'user';
    } catch (e) {
        // Some browsers might not support getSettings()
        isFrontCamera = currentFacingMode === 'user';
    }

    // Use ideal constraint instead of exact for better compatibility
    const newFacingMode = isFrontCamera ? 'environment' : 'user';
    currentFacingMode = newFacingMode;

    try {
        // Stop the current video track
        currentVideoTrack.stop();

        // Get a new stream with the desired facing mode
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: newFacingMode } },
            audio: false // Don't get audio as we'll keep the existing audio track
        });

        const newVideoTrack = newStream.getVideoTracks()[0];

        // Replace the track in the local stream
        // First remove old track from localStream
        localStream.removeTrack(currentVideoTrack);
        // Add new track to localStream
        localStream.addTrack(newVideoTrack);

        // Update the video element
        const localVideo = document.getElementById('local-video');
        if (localVideo) {
            localVideo.srcObject = localStream;
        }

        // Update the track in the RTCPeerConnection if it exists
        if (peerConnection && peerConnection.signalingState !== 'closed') {
            const senders = peerConnection.getSenders();
            const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
            
            if (videoSender) {
                console.log('Replacing video track in RTCPeerConnection');
                await videoSender.replaceTrack(newVideoTrack);
                console.log('Video track replaced successfully');
            }
        }
    } catch (error) {
        console.error('Error switching camera:', error);
        alert('Error switching camera: ' + error.message);

        // Try fallback to general video constraints
        try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: false
            });

            const fallbackVideoTrack = fallbackStream.getVideoTracks()[0];

            // Replace in local stream
            localStream.removeTrack(currentVideoTrack);
            localStream.addTrack(fallbackVideoTrack);

            // Update video element
            const localVideo = document.getElementById('local-video');
            if (localVideo) {
                localVideo.srcObject = localStream;
            }

            // Update in peer connection
            if (peerConnection && peerConnection.signalingState !== 'closed') {
                const senders = peerConnection.getSenders();
                const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
                
                if (videoSender) {
                    await videoSender.replaceTrack(fallbackVideoTrack);
                }
            }
        } catch (fallbackError) {
            console.error('Fallback camera also failed:', fallbackError);
            alert('Failed to switch camera. Your device may not support this feature.');

            // If all fails, try to reinitialize with default camera
            try {
                await initializeMediaStream();
                
                // If we have an active connection, we need to reconnect
                if (peerConnection && peerConnection.signalingState !== 'closed') {
                    alert('Reconnecting to update camera change...');
                    createAndSendOffer();
                }
            } catch (e) {
                console.error('Failed to recover camera after switch error:', e);
                alert('Camera recovery failed. Try restarting the stream.');
            }
        }
    }
}

document.addEventListener('deviceready', onDeviceReady, false);