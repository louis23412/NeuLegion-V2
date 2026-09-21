// NeuLegion legion component: local IP discovery
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

import os from 'os';

export const getLocalIP = () => {
    const interfaces = os.networkInterfaces();
    let ipAddress;

    Object.keys(interfaces).forEach((ifaceName) => {
        interfaces[ifaceName].forEach((iface) => {
            if (iface.family === 'IPv4' && !iface.internal) {
                ipAddress = iface.address;
            }
        });
    });

    return ipAddress;
}
