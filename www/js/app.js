// --- WebRTC Globals ---
let localStream;
let peerConnection;
const signalingServerUrl = "PRIVATE_WEB_URL"; // Will be replaced during build by GitHub Actions
let sessionId; // To identify this specific WebRTC session
let pollingIntervalId; // Store the interval ID for signaling polling
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let isReconnecting = false;
let keepAliveIntervalId;
let appIsInBackground = false;
let isStreaming = false;
let backgroundResumeTimeout = null;
let backgroundStartTime = 0;

const peerConnectionConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Add TURN servers for better connectivity through firewalls/NATs
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
        return true;
    } catch (e) {
        alert(`Error sending signaling message (${message.type}): ${e.message}`);
        console.error('Send signaling error:', e);
        return false;
    }
}

async function listenForSignalingMessages(currentSessionId) {
    if (pollingIntervalId) {
        clearInterval(pollingIntervalId);
    }
    
    const intervalId = setInterval(async () => {
        // Don't poll when app is in background for more than 30 seconds
        if (appIsInBackground && Date.now() - backgroundStartTime > 30000) {
            return;
        }
        
        if (!peerConnection || peerConnection.signalingState === 'closed') {
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
                    } else if (message.type === 'pong') {
                        console.log('Received pong from viewer - connection alive');
                    } else if (message.type === 'hangup') {
                        console.log('Received hangup from viewer');
                        stopWebRTCStream();
                    } else if (message.type === 'connection-check') {
                        // Respond to connection check requests from viewers
                        sendSignalingMessage({ 
                            type: 'connection-status', 
                            status: appIsInBackground ? 'background' : 'foreground',
                            sessionId: currentSessionId
                        });
                    }
                }
            } else if (response.status !== 404) {
                console.error('Error fetching signaling messages:', response.status, await response.text());
            }
        } catch (e) {
            // console.warn('Polling error:', e.message);
        }
    }, 1000); // Faster polling (match viewer.html)
    
    // Start a keepalive ping mechanism
    if (keepAliveIntervalId) {
        clearInterval(keepAliveIntervalId);
    }
    
    keepAliveIntervalId = setInterval(() => {
        // Don't send pings when in background for too long
        if (appIsInBackground && Date.now() - backgroundStartTime > 30000) {
            return;
        }
        
        if (peerConnection && sessionId && 
            (peerConnection.iceConnectionState === 'connected' || 
            peerConnection.iceConnectionState === 'completed')) {
            sendSignalingMessage({ 
                type: 'ping', 
                sessionId,
                origin: 'initiator', // Mark as coming from the app (initiator)
                appState: appIsInBackground ? 'background' : 'foreground' // Add app state information
            });
            console.log('Sending ping to keep connection alive');
        }
    }, 10000); // Send ping every 10 seconds
    
    return intervalId;
}

// Update the capture button based on streaming state
function updateCaptureButtonState(streaming) {
    isStreaming = streaming; // Track streaming state
    
    const captureBtn = document.getElementById('capture-btn');
    if (streaming) {
        captureBtn.classList.add('streaming');
    } else {
        captureBtn.classList.remove('streaming');
    }
}

// Modified functions to update button state
async function startWebRTCStream() {
    if (peerConnection && peerConnection.iceConnectionState !== 'closed' && peerConnection.iceConnectionState !== 'failed') {
        alert('A stream is already active or attempting to connect.');
        return;
    }
    
    // Update button state to streaming
    updateCaptureButtonState(true);
    
    alert('Starting WebRTC stream setup...');
    reconnectAttempts = 0;
    isReconnecting = false;
    
    try {
        // Make sure we've requested permissions first
        await ensureCameraPermissions();
        
        // Check if camera is available
        await checkCameraAvailability();
        
        await initializeMediaStream();
        
        // Setup WebRTC peer connection
        setupPeerConnection();
        
    } catch (e) {
        alert('Error starting WebRTC stream: ' + e.message);
        console.error('WebRTC Start Error:', e);
        stopWebRTCStream();
    }
}

async function initializeMediaStream() {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        // Set constraints for mobile devices with fallback options
        const constraints = {
            video: {
                width: { ideal: 1280, min: 640 },
                height: { ideal: 720, min: 480 },
                facingMode: 'environment' // Use the back camera by default
            },
            audio: true
        };
        
        try {
            console.log('Attempting to access media with constraints:', JSON.stringify(constraints));
            
            // Check camera device permissions for Android 13+ explicitly
            if (window.cordova && 
                device && 
                device.platform === "Android" && 
                parseInt(device.version) >= 13) {
                await checkAndroidCamera13Permissions();
            }
            
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log('Successfully obtained media stream');
            
            // Create a video element to display the local stream (optional)
            const videoElement = document.getElementById('local-video');
            if (videoElement) {
                videoElement.srcObject = localStream;
            }
            
        } catch (mediaError) {
            console.error('Initial getUserMedia error:', mediaError);
            
            // Try with video-only constraints first
            try {
                alert('Trying video-only access... Error: ' + mediaError.message);
                console.log('Falling back to video-only constraints');
                localStream = await navigator.mediaDevices.getUserMedia({ 
                    video: true, 
                    audio: false 
                });
                console.log('Successfully obtained video-only stream');
                
                // Try adding audio separately if video works
                try {
                    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    const audioTrack = audioStream.getAudioTracks()[0];
                    localStream.addTrack(audioTrack);
                    console.log('Successfully added audio track to stream');
                } catch (audioError) {
                    console.warn('Could not add audio to stream:', audioError);
                    // Continue with video only
                }
                
            } catch (videoError) {
                // Final fallback - try with minimal constraints
                try {
                    alert('Trying simplified camera access... Error: ' + videoError.message);
                    console.log('Falling back to minimal constraints');
                    
                    // Try with most basic settings possible
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
                    // Try one last approach - enumerate devices first
                    try {
                        const devices = await navigator.mediaDevices.enumerateDevices();
                        const videoDevices = devices.filter(device => device.kind === 'videoinput');
                        
                        if (videoDevices.length > 0) {
                            // Try to use a specific camera device
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

function stopWebRTCStream() {
    // Clear any polling intervals
    if (pollingIntervalId) {
        clearInterval(pollingIntervalId);
        pollingIntervalId = null;
    }
    
    if (keepAliveIntervalId) {
        clearInterval(keepAliveIntervalId);
        keepAliveIntervalId = null;
    }
    
    // Notify viewers that we're stopping the stream
    if (sessionId && peerConnection) {
        sendSignalingMessage({ type: 'hangup', sessionId });
    }
    
    // Stop all tracks in the local stream
    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
            console.log(`Stopped ${track.kind} track`);
        });
        localStream = null;
    }
    
    // Close the peer connection
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    // Update button state to not streaming
    updateCaptureButtonState(false);
    
    alert('Stream stopped.');
    sessionId = null;
    
    // Clear video element if exists
    const videoElement = document.getElementById('local-video');
    if (videoElement) {
        videoElement.srcObject = null;
    }
    
    // Reset reconnection state
    isReconnecting = false;
    reconnectAttempts = 0;
}

// Pause the stream without fully stopping it (for quick resume)
function pauseStream() {
    // Pause local tracks
    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.enabled = false;
        });
    }
    
    // Keep isStreaming flag but note we're paused
    console.log('Stream paused');
}

// Resume a paused stream
async function resumeStream() {
    console.log('Attempting to resume stream...');
    
    try {
        // If we don't have a local stream anymore or all tracks are ended, get a new one
        let needNewStream = !localStream || 
                        localStream.getTracks().every(track => track.readyState === 'ended');
        
        if (needNewStream) {
            await initializeMediaStream();
        } else {
            // Just re-enable existing tracks
            localStream.getTracks().forEach(track => {
                track.enabled = true;
            });
        }
        
        // If peer connection was closed, restart it
        if (!peerConnection || 
            peerConnection.iceConnectionState === 'closed' || 
            peerConnection.iceConnectionState === 'failed') {
            setupPeerConnection();
        }
        
        console.log('Stream resumed');
    } catch (e) {
        alert('Failed to resume stream: ' + e.message);
        console.error('Resume stream error:', e);
        
        // If we can't resume, stop completely
        stopWebRTCStream();
    }
}

// Helper function to set up the peer connection
function setupPeerConnection() {
    try {
        if (peerConnection) {
            peerConnection.close();
        }
        
        peerConnection = new RTCPeerConnection(peerConnectionConfig);
        
        // Add tracks from local stream to peer connection
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
            console.log('Added track to peer connection:', track.kind);
        });
        
        // Set up event handlers
        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                sendSignalingMessage({ 
                    type: 'candidate', 
                    candidate: event.candidate, 
                    sessionId,
                    origin: 'initiator'  // Mark this candidate as coming from initiator
                });
            }
        };
        
        peerConnection.oniceconnectionstatechange = () => {
            console.log(`ICE connection state: ${peerConnection.iceConnectionState}`);
            if (peerConnection.iceConnectionState === 'connected') {
                alert('Stream connected!');
                // Reset reconnection attempts when connected
                isReconnecting = false;
                reconnectAttempts = 0;
            } else if (peerConnection.iceConnectionState === 'failed') {
                console.log('Stream connection failed, attempting to recover...');
                handleConnectionFailure();
            } else if (peerConnection.iceConnectionState === 'disconnected') {
                console.log('Stream temporarily disconnected. Waiting for reconnection...');
                // Wait a moment to see if it auto-recovers before trying to reconnect
                setTimeout(() => {
                    if (peerConnection && peerConnection.iceConnectionState === 'disconnected') {
                        handleConnectionFailure();
                    }
                }, 5000);
            } else if (peerConnection.iceConnectionState === 'closed') {
                console.log('Stream connection closed.');
                stopWebRTCStream();
            }
        };
        
        peerConnection.onsignalingstatechange = () => {
            console.log(`Signaling state: ${peerConnection.signalingState}`);
        };
        
        // Create and send offer
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
            // Close existing connection
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            
            // Setup new connection
            setupPeerConnection();
        } catch (e) {
            console.error('Reconnection attempt failed:', e);
            
            // Wait a moment before trying again
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

// Helper function to create and send offer
async function createAndSendOffer() {
    try {
        const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
            iceRestart: isReconnecting // Use ice restart for reconnection attempts
        });
        await peerConnection.setLocalDescription(offer);
        
        if (!sessionId) {
            // Generate session ID only if not reconnecting
            sessionId = generateUniqueId();
            alert(`Streaming session ID: ${sessionId}\nShare this ID with the viewer.`);
        }
        
        const success = await sendSignalingMessage({ type: 'offer', offer: offer, sessionId });
        if (!success) {
            throw new Error('Failed to send offer to signaling server');
        }
        
        // Start listening for messages
        pollingIntervalId = await listenForSignalingMessages(sessionId);
        
    } catch (error) {
        console.error('Error creating or sending offer:', error);
        alert('Failed to create connection offer: ' + error.message);
        throw error;
    }
}

// Helper function to share the session link
async function shareSessionLink() {
    if (!sessionId) {
        alert('Please start a stream first to get a session ID.');
        return;
    }    // Extract the base URL from signalingServerUrl
    const viewerBaseUrl = signalingServerUrl.substring(0, signalingServerUrl.lastIndexOf('/') + 1);
    const shareUrl = `${viewerBaseUrl}viewer.html?sessionId=${sessionId}`;

    try {
        // Use the Navigator Clipboard API to write text to the clipboard
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(shareUrl);
            alert('Stream link copied to clipboard!');
            console.log('Link copied to clipboard');
        }
    } catch (error) {
        prompt('Please copy this link to share the stream:', shareUrl);
    }
}

function onDeviceReady() {
    console.log('Device ready event fired');
    
    // Check if the device plugin is available (needed for Android version detection)
    if (!window.device) {
        console.warn('Device plugin not available - some Android 13+ specific features may not work correctly');
    } else {
        console.log(`Device platform: ${device.platform}, version: ${device.version}`);
    }
    
    // Set initial button state
    updateCaptureButtonState(false);
    
    // Check for camera permissions on startup
    requestCameraPermission();
    
    document.getElementById('capture-btn').addEventListener('click', function() {
        if (!peerConnection || peerConnection.iceConnectionState === 'closed' || peerConnection.iceConnectionState === 'failed') {
            startWebRTCStream();
        } else {
            stopWebRTCStream();
        }
    });

    // Add event listener for the Send button
    document.getElementById('send-btn').addEventListener('click', shareSessionLink);
    
    // Add event listeners for app going to background/foreground
    document.addEventListener('pause', onAppPause, false);
    document.addEventListener('resume', onAppResume, false);
}

// Handler for when app goes to background
function onAppPause() {
    console.log('App went to background');
    appIsInBackground = true;
    backgroundStartTime = Date.now();
    
    // If we're streaming, notify viewers that app is paused
    if (isStreaming && sessionId) {
        sendSignalingMessage({ 
            type: 'app-state', 
            state: 'background',
            sessionId: sessionId
        });
    }
    
    // Note: We don't stop the stream immediately to allow for quick task switching
    // Instead, set a timeout to stop if we stay in background too long
    if (backgroundResumeTimeout) {
        clearTimeout(backgroundResumeTimeout);
    }
    
    backgroundResumeTimeout = setTimeout(() => {
        if (appIsInBackground && isStreaming) {
            console.log('App in background too long, stopping stream');
            // Save session ID for potential resumption
            const savedSessionId = sessionId;
            
            // Stop WebRTC connection but keep track that we were streaming
            pauseStream();
            
            // Notify viewers the stream is fully stopped, not just paused
            if (savedSessionId) {
                sendSignalingMessage({ 
                    type: 'app-state', 
                    state: 'stream-ended',
                    sessionId: savedSessionId
                });
            }
        }
    }, 30000); // 30 seconds
}

// Handler for when app comes back to foreground
function onAppResume() {
    console.log('App returned to foreground');
    appIsInBackground = false;
    
    if (backgroundResumeTimeout) {
        clearTimeout(backgroundResumeTimeout);
        backgroundResumeTimeout = null;
    }
    
    // If we were streaming when we went to background and connection is still active
    // just notify viewers that we're back
    if (isStreaming && sessionId && peerConnection && 
        (peerConnection.iceConnectionState === 'connected' || 
         peerConnection.iceConnectionState === 'completed')) {
        
        sendSignalingMessage({ 
            type: 'app-state', 
            state: 'foreground',
            sessionId: sessionId
        });
    } 
    // If our connection was closed/failed but we were streaming, try to resume
    else if (isStreaming && (!peerConnection || 
             peerConnection.iceConnectionState === 'disconnected' || 
             peerConnection.iceConnectionState === 'failed' || 
             peerConnection.iceConnectionState === 'closed')) {
        
        alert('Resuming stream after background...');
        resumeStream();
    }
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

// Check if camera is actually available and working
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
            // Just assume camera is available if we can't check
            resolve(true);
        }
    });
}

// Special function for handling Android 13+ camera permissions
function checkAndroidCamera13Permissions() {
    return new Promise((resolve, reject) => {
        if (window.cordova && cordova.plugins && cordova.plugins.permissions) {
            const permissions = cordova.plugins.permissions;
            
            // For Android 13+, need to check specific permissions
            if (device && device.platform === "Android" && parseInt(device.version) >= 13) {
                console.log("Checking Android 13+ specific camera permissions...");
                
                // On Android 13+, we may need to check for READ_MEDIA_IMAGES, READ_MEDIA_VIDEO permissions
                const requiredPermissions = [
                    permissions.CAMERA,
                    permissions.RECORD_AUDIO,
                    permissions.MODIFY_AUDIO_SETTINGS,
                    // Android 13 specific permissions if available
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
                        // Skip if permission is undefined (might happen for newer permissions on older plugin)
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
                                    // Continue anyway - not all might be required on all devices
                                }
                                requestNextPermission(index + 1);
                            }, error => {
                                console.warn(`Error requesting permission ${permission}:`, error);
                                // Continue with next permission regardless of error
                                requestNextPermission(index + 1);
                            });
                        }
                    }, error => {
                        console.warn(`Error checking permission ${permission}:`, error);
                        // Continue with next permission regardless of error
                        requestNextPermission(index + 1);
                    });
                }
                
                // Start requesting permissions
                requestNextPermission(0);
            } else {
                // For Android versions below 13, normal permissions should be sufficient
                resolve();
            }
        } else {
            // Resolve if not on Cordova or plugins not available
            resolve();
        }
    });
}

// Updated function to ensure camera permissions are granted
function ensureCameraPermissions() {
    return new Promise((resolve, reject) => {
        // Check if we're running in a Cordova environment
        if (window.cordova && cordova.plugins && cordova.plugins.permissions) {
            const permissions = cordova.plugins.permissions;
            
            // Android permissions to request
            const requiredPermissions = [
                permissions.CAMERA,
                permissions.RECORD_AUDIO,
                permissions.MODIFY_AUDIO_SETTINGS
            ];
            
            // If on Android 13+, add specific media permissions when using standard permissions API
            if (device && device.platform === "Android" && parseInt(device.version) >= 13) {
                if (permissions.READ_MEDIA_IMAGES) {
                    requiredPermissions.push(permissions.READ_MEDIA_IMAGES);
                }
                if (permissions.READ_MEDIA_VIDEO) {
                    requiredPermissions.push(permissions.READ_MEDIA_VIDEO);
                }
            }
            
            // Check permissions
            function checkAndRequestPermission(permissionIndex) {
                if (permissionIndex >= requiredPermissions.length) {
                    // All permissions granted
                    resolve();
                    return;
                }
                
                const permission = requiredPermissions[permissionIndex];
                if (!permission) {
                    // Skip if permission is undefined (might happen for newer permissions on older plugin)
                    checkAndRequestPermission(permissionIndex + 1);
                    return;
                }
                
                permissions.checkPermission(permission, status => {
                    if (status.hasPermission) {
                        // This permission is granted, move to next
                        checkAndRequestPermission(permissionIndex + 1);
                    } else {
                        // Request this permission
                        permissions.requestPermission(permission, status => {
                            if (status.hasPermission) {
                                // Permission granted, move to next
                                checkAndRequestPermission(permissionIndex + 1);
                            } else {
                                // Permission denied
                                console.error(`Permission ${permission} denied`);
                                if (permission === permissions.CAMERA) {
                                    reject(new Error('Camera permission not granted - required for this app'));
                                } else {
                                    // For non-critical permissions, continue anyway
                                    checkAndRequestPermission(permissionIndex + 1);
                                }
                            }
                        }, error => {
                            console.error(`Error requesting permission ${permission}:`, error);
                            if (permission === permissions.CAMERA) {
                                reject(new Error('Error requesting camera permission: ' + error));
                            } else {
                                // For non-critical permissions, continue anyway
                                checkAndRequestPermission(permissionIndex + 1);
                            }
                        });
                    }
                }, error => {
                    console.error(`Error checking permission ${permission}:`, error);
                    if (permission === permissions.CAMERA) {
                        reject(new Error('Error checking camera permission: ' + error));
                    } else {
                        // For non-critical permissions, continue anyway
                        checkAndRequestPermission(permissionIndex + 1);
                    }
                });
            }
            
            // Start checking permissions
            checkAndRequestPermission(0);
        } else {
            // Not in Cordova or plugins not available - assume permissions granted
            console.log('Not using Cordova permissions plugin, assuming permissions granted');
            resolve();
        }
    });
}

document.addEventListener('deviceready', onDeviceReady, false);