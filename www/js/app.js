document.addEventListener('deviceready', onDeviceReady, false);

function onDeviceReady() {
    // Camera preview options
    var options = {
        x: 0,
        y: 60, // leave space for the button
        width: window.screen.width,
        height: window.screen.height - 60,
        camera: CameraPreview.CAMERA_DIRECTION.BACK,
        toBack: false,
        tapPhoto: false,
        tapFocus: true,
        previewDrag: false,
        storeToFile: false
    };
    try {
        CameraPreview.startCamera(options);
    } catch (e) {
        alert('CameraPreview error: ' + e.message);
    }

    document.getElementById('capture-btn').addEventListener('click', function() {
        try {
            CameraPreview.takePicture({width:640, height:640, quality:85}, function(base64PictureData) {
                var img = document.getElementById('captured-img');
                img.src = 'data:image/jpeg;base64,' + base64PictureData;
                img.style.display = 'block';
            });
        } catch (e) {
            alert('Capture error: ' + e.message);
        }
    });
}