## Run the cafeteria websites

### Start the websites on your Windows computer

The student and staff websites are served by the same Node.js server. Do not open `server.js` in a browser or double-click it; open the project folder in VS Code and start it from the VS Code terminal.

1. Install [Node.js](https://nodejs.org/) if it is not already installed.
2. In VS Code, choose **File → Open Folder…** and open the folder containing `server.js`, `student.html`, `staff.html`, and `package.json`. In this project, that folder is:

   ```text
   C:\Users\lacmi\OneDrive\Documents
   ```

   In the Explorer pane, you should be able to see `server.js` and `package.json` at the top level.
3. Open **Terminal → New Terminal** in VS Code. Make sure the terminal is in that project folder. If it is not, run:

   ```powershell
   cd "C:\Users\lacmi\OneDrive\Documents"
   ```

4. If this is the first run, install the project dependencies once:

   ```powershell
   npm install
   ```

5. Set the first staff account and start the server in that same terminal window. Use your own private password with at least 12 characters; do not put a real password in this README or share it.

   ```powershell
   $env:BOOTSTRAP_STAFF_ID = "cafeteria-admin"
   $env:BOOTSTRAP_STAFF_PASSWORD = "replace-this-with-a-private-12-character-or-longer-password"
   npm start
   ```

   Leave this terminal open while the websites are in use. A message that the server is running means it started. If port 3000 is already occupied, stop the other server or add `$env:PORT = "3001"` before `npm start`, then use port `3001` in the browser addresses below.
6. On the same computer, open these addresses in a browser:

   - Student website: `http://localhost:3000/`
   - Staff website: `http://localhost:3000/staff.html`

   Sign in to the staff website using the staff ID and password configured above. Staff can then create student accounts and add credit after verifying that the school received the funds.
7. To stop the server, return to its terminal and press **Ctrl+C**. Start it again with `npm start` when you need the sites again. The first staff account is created only if its ID does not already exist; setting the bootstrap environment variables later does not reset an existing account's password.

### Open the sites on other devices on the same Wi-Fi

The server listens on the computer's network interfaces, but `localhost` only works on the computer running the server. To use the portals from a phone or another computer:

1. Keep the server running and connect the other device to the same trusted Wi-Fi network.
2. On the server computer, open a second PowerShell terminal and run `ipconfig`. Find the active Wi-Fi adapter's **IPv4 Address** (for example, `192.168.1.25`).
3. On the other device, open:

   - Student website: `http://<server-computer-IPv4-address>:3000/`
   - Staff website: `http://<server-computer-IPv4-address>:3000/staff.html`

   Replace the example placeholder with the actual IPv4 address; do not type the angle brackets. For example, if it is `192.168.1.25`, use `http://192.168.1.25:3000/`.
4. If Windows Firewall asks, allow Node.js on **Private networks only**, and only on a network you trust. If the pages still do not load, ask the network administrator whether device-to-device connections are allowed on that Wi-Fi.

This same-Wi-Fi setup is **local network access, not a public internet website**. `localhost` and a private Wi-Fi address are not reachable by people outside that network. Do not expose port 3000 directly to the public internet.

### Where wallet data is saved

By default, local accounts, wallet balances, transaction records, and orders are saved in `server-data.json` in the project folder. Keep the server running on the same computer and back up this file securely. Do not email it, commit it to a public repository, or edit it while the server is running. If `DATABASE_URL` is configured, the server uses PostgreSQL instead. Local JSON storage is for a single server process; it is not suitable for several server instances sharing real balances.

### Before using real balances

For local UI testing, use test accounts and test balances only. **Do not use real credentials or real balances over the `http://` addresses above.** HTTP does not encrypt passwords or session cookies between devices.

Before handling real school funds, get school approval, verify student identities, use trusted HTTPS for all devices, secure and back up persistent database storage, and agree on procedures for top-ups, disputes, and refunds. To enable HTTPS directly, configure both `TLS_CERT_FILE` and `TLS_KEY_FILE` before starting Node; alternatively, deploy behind an HTTPS proxy and set `NODE_ENV=production` so session cookies are marked Secure. Devices must trust the HTTPS certificate.

The wallet uses prepaid credit that staff record only after verifying that funds were received through the school's approved process. It does not take card/e-wallet payments and is not a bank or regulated e-money wallet. Order totals are deducted immediately; staff can cancel and refund a paid order only while its status is still `New`.

Local JSON storage is intended for one server process. For a shared deployment, configure a properly managed PostgreSQL database with `DATABASE_URL`.
