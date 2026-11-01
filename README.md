## Run the cafeteria websites

### Start the websites on your Windows computer

The student and staff websites are served by the same Node.js server. Do not open `server.js` in a browser or double-click it; open the project folder in VS Code and start it from the VS Code terminal.

1. Install [Node.js](https://nodejs.org/) if it is not already installed.
2. In VS Code, choose **File → Open Folder…** and open the folder containing `server.js`, `student.html`, `staff.html`, and `package.json`. In this checkout, that folder is:

   ```text
C:\Users\lacmi\OneDrive\Documents\CAFONLMN
   ```

   In the Explorer pane, you should be able to see `server.js` and `package.json` at the top level.
3. Open **Terminal → New Terminal** in VS Code. Make sure the terminal is in that project folder. If it is not, run:

   ```powershell
   cd "C:\Users\lacmi\OneDrive\Documents\CAFONLMN"
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

   Sign in to the staff website using the staff ID and password configured above. Students can create zero-balance demo accounts from the student sign-in page. Staff applicants can request an account from the staff sign-in page; an existing staff member must verify the applicant in person and approve the request before it can sign in. Staff can also create student accounts directly and add clearly labeled test credits.
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

By default, local accounts, pending staff requests, wallet balances, transaction records, and orders are saved in `server-data.json` in the project folder. Keep the server running on the same computer and back up this file securely. Do not email it, commit it to a public repository, or edit it while the server is running. If `DATABASE_URL` is configured, the server uses PostgreSQL instead. Local JSON storage is for a single server process; it is not suitable for several server instances sharing real balances.

The staff and student portals keep separate sign-in sessions, so using both portals in the same browser does not replace one role's session with the other. If a staff action says you do not have permission, sign out of the staff portal and back in with an approved staff account; a student login cannot perform staff actions.

### Ordering and payment demo limits

- Every menu item is priced at ₱20 or less. The 5% service fee is added to the order total, so the total can exceed ₱20 when ordering multiple items.
- Students can request a pickup time 5 minutes to 24 hours ahead. Staff see the requested time in the order queue; it is a request, not a guaranteed or automatically confirmed slot.
- Order numbers are digital tickets shown after checkout and saved in the student's **My orders and digital tickets** history. No physical printer/ticket is required.
- Student self-registration creates an account with zero demo credit. Staff applications stay pending until an existing staff member verifies the applicant and approves or rejects the request. Staff registration requests store a password hash, not the submitted password.
- Student self-registration does not verify school identity. Do not use it as-is for real student accounts or funds; a real deployment needs an approved identity-verification process.
- This project does not process online purchases, card payments, or e-wallet payments. Staff-added balances are test credits only for this demo; do not enter real payment details or use real funds. Before adding an online payment provider, use its sandbox and verified payment callbacks rather than trusting a browser-reported payment.

### Before using real balances

For local UI testing, use test accounts and test balances only. **Do not use real credentials or real balances over the `http://` addresses above.** HTTP does not encrypt passwords or session cookies between devices.

Before handling real school funds, get school approval, verify student identities, use trusted HTTPS for all devices, secure and back up persistent database storage, and agree on procedures for top-ups, disputes, and refunds. To enable HTTPS directly, configure both `TLS_CERT_FILE` and `TLS_KEY_FILE` before starting Node; alternatively, deploy behind an HTTPS proxy and set `NODE_ENV=production` so session cookies are marked Secure. Devices must trust the HTTPS certificate.

The demo wallet uses test credits that staff add manually; it does not take card/e-wallet payments and is not a bank or regulated e-money wallet. For any future real-fund use, credit must be added only after an approved payment provider confirms payment. Order totals are deducted immediately; staff can cancel and refund a paid order only while its status is still `New`.

Local JSON storage is intended for one server process. For a shared deployment, configure a properly managed PostgreSQL database with `DATABASE_URL`.

## ESP32 RFID demo (microSD optional)

The [sketch_sep.ino](./sketch_sep.ino) sketch works with an ESP32 DevKit board and an MFRC522/RC522 13.56 MHz RFID reader. A microSD module is optional: without one, the reader still sends scans to this app over Wi-Fi, but it does not save a local CSV log. With a working microSD module installed, scans are also appended to `/rfid_scans.csv`. Staff can link a card to a student, a scan can pay one pending test order from that student's campus-credit balance, and staff can scan to look up that student's orders and confirm pickup in the staff portal.

**Demo use only.** Common card UIDs can be copied, and the ESP32 demo uses plain HTTP on the local network. Do not use this as secure authentication or with real funds or sensitive accounts. Keep the server on a trusted private Wi-Fi network; do not expose port 3000 to the public internet.

### Arduino IDE setup

1. Install the Arduino IDE and add the ESP32 board support package using **Boards Manager** (search for **esp32 by Espressif Systems**).
2. In **Library Manager**, install **MFRC522 by GithubCommunity** (the miguelbalboa MFRC522 library).
3. In the Arduino IDE, open `sketch_sep.ino` and select your exact ESP32 board under **Tools → Board**.
4. Edit `wifiName` and `wifiPassword` near the top of the sketch for the router the ESP32 will use. Keep real Wi-Fi credentials out of GitHub; if you switch computers or networks, enter that network's details locally.
5. Disconnect power before wiring. Connect the RC522 to the ESP32 according to the pin map below. You can omit the microSD module and its wires. If you have a working SD module, format its card as FAT32 and connect its separate CS wire as shown.
6. Connect the ESP32 over USB, choose the correct serial port, and click **Upload**. Open **Tools → Serial Monitor** at **115200 baud** to check Wi-Fi, the RC522, and (if installed) microSD status.
7. Tap a compatible card/key fob. Its UID is printed in Serial Monitor and sent to the server when Wi-Fi is connected. If a working microSD is installed, the UID and ESP32 uptime are also appended to `rfid_scans.csv`. The uptime is milliseconds since boot, not a real date/time.

### Example SPI wiring (common ESP32 DevKit + RC522; optional microSD)

| ESP32 pin | RC522 pin | microSD module pin |
| --- | --- | --- |
| GPIO 18 | SCK | SCK / CLK |
| GPIO 19 | MISO | MISO / DO |
| GPIO 23 | MOSI | MOSI / DI |
| GPIO 21 | SDA / SS / CS | — |
| GPIO 22 | RST | — |
| GPIO 27 | — | CS |
| 3V3 | 3.3V power | 3.3V-compatible module power, per its documentation |
| GND | GND | GND |

The two modules share SPI clock/data, but each has its **own chip-select wire**. This example pinout is not universal: confirm the labels and voltage requirements for your exact ESP32, RFID reader, and SD breakout before connecting power. The RC522 uses 3.3 V logic; never feed 5 V signals into ESP32 or RC522 pins. Some SD breakouts include a regulator or level shifting and have different power input requirements. Do not connect a module's 5 V output to the ESP32's 3.3 V rail.

### Connect the reader to the local demo app

1. Connect the server computer and ESP32 to the same trusted Wi-Fi. In PowerShell, run `ipconfig` and note the computer's Wi-Fi IPv4 address (for example, `192.168.1.25`).
2. Stop any running server with **Ctrl+C**. In the VS Code terminal opened in the folder containing `server.js`, set a private device token, then start the server. Keep this token private and do not commit it:

   ```powershell
   $env:HOST = "0.0.0.0"
   $env:BOOTSTRAP_STAFF_ID = "cafeteria-admin"
   $env:BOOTSTRAP_STAFF_PASSWORD = "replace-this-with-a-private-12-character-or-longer-password"
   $env:RFID_DEVICE_TOKEN = (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
   $env:RFID_DEVICE_TOKEN
   npm start
   ```

   Save the displayed token locally so you can enter the exact same value in the sketch. If the existing staff account is already set up, its password is not reset by these environment variables. Allow Node.js through Windows Firewall on **Private networks only** if prompted.
3. In `sketch_sep.ino`, set `serverBaseUrl` to `http://<server-computer-IPv4-address>:3000` (for example, `http://192.168.1.25:3000`) and set `rfidDeviceToken` to the token from step 2. Configure the Wi-Fi name/password, upload the sketch, and open Serial Monitor at 115200 baud. Do not commit the edited sketch with Wi-Fi credentials or the token.
4. Open `http://localhost:3000/staff.html` on the server computer and sign in. Create or choose a demo student account, enter the student's ID under **Link a demo RFID card**, start enrollment, then tap their card at the reader within two minutes.
5. To test payment, add credit only to a demo student account and put `DEMO ONLY - NOT REAL FUNDS` in its reference. Create an order from that student's portal using **Create order · pay at RFID reader**, then tap the linked card. A successful scan deducts the order total once and moves the order to the staff queue. For pickup lookup, scan the card again; the staff portal filters to that student's orders, and staff confirms pickup using the order action.

The microSD scan log contains card UIDs and should be handled as sensitive data. The reader does not authenticate a card cryptographically; the UID-to-student mapping and shared device token are for a local classroom demo only. Never use this prototype to authorize real payments.
