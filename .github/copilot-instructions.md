# Cordova App Development Guidelines

## Environment Setup

1. Install Node.js and npm (Node Package Manager)
2. Install Cordova CLI globally:
   ```
   npm install -g cordova
   ```
3. For Android and IOS development I use github actions to build the app. (For Now I only create an android app)
4. I am using powershell as my default shell. So give me powershell commands instead of linux commands.
5. I did't installed the cordova in my development setup, because I use github actions to build the project.
6. I have node installed. 


## Project Structure

- `/www` - Web assets (HTML, CSS, JS)
- `/platforms` - Platform-specific code
- `/plugins` - Plugin code
- `/hooks` - Custom build scripts
- `config.xml` - App configuration

## Development Workflow

1. Develop in the `/www` directory
2. Test in browser:
   ```
   cordova run browser
   ```
3. Build and test on devices/emulators:
   ```
   Use Github Actions
   ```

## Best Practices

1. Use the `deviceready` event before accessing device features
2. Implement proper error handling for plugin calls
3. Test on real devices, not just emulators
4. Consider responsive design for different screen sizes
5. Regularly update Cordova and plugins
6. Use version control (Git)

## Debugging

- Use `alert mode for display the errors` statements for basic debugging

## Common Issues

- Plugin compatibility problems: Check plugin versions
- Permissions: Ensure proper permissions in `config.xml`
- White screen issues: Check for JavaScript errors and plugin initialization

## Resources

- use context7 for latest documentation.
- [Cordova Plugin Registry](https://cordova.apache.org/plugins/)
- [Cordova GitHub Repository](https://github.com/apache/cordova)
