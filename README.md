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

## ESP32 RFID and microSD prototype

The sketch at `Arduino/sketch_sep2a/sketch_sep2a.ino` is for a common ESP32 DevKit board, an MFRC522/RC522 13.56 MHz RFID reader, and an SPI microSD module. It connects to Wi-Fi if configured, prints the ESP32's local IP, reads card UIDs, and appends them to `/rfid_scans.csv` on the SD card. It does **not** connect scans to student accounts, contact the cafeteria server, charge campus credit, or confirm order pickup. Treat card UIDs and the SD log as sensitive identifiers.

### Arduino IDE setup

1. Install the Arduino IDE and add the ESP32 board support package using **Boards Manager** (search for **esp32 by Espressif Systems**).
2. In **Library Manager**, install **MFRC522 by GithubCommunity** (the miguelbalboa MFRC522 library).
3. In the Arduino IDE, open `Arduino/sketch_sep2a/sketch_sep2a.ino` and select your exact ESP32 board under **Tools → Board**.
4. Edit `wifiName` and `wifiPassword` near the top of the sketch for the router the ESP32 will use. Keep real Wi-Fi credentials out of GitHub; if you switch computers or networks, enter that network's details locally.
5. Format the microSD card as FAT32, disconnect power before wiring, then connect the modules according to the pin map below. Use jumper leads and a shared ground.
6. Connect the ESP32 over USB, choose the correct serial port, and click **Upload**. Open **Tools → Serial Monitor** at **115200 baud** to see whether Wi-Fi, the SD module, and the RC522 initialized.
7. Tap a compatible card/key fob. Its UID and ESP32 uptime are printed in Serial Monitor and appended to `rfid_scans.csv`. The uptime is milliseconds since boot, not a real date/time.

### Example SPI wiring (common ESP32 DevKit + RC522 + microSD SPI breakout)

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

The ESP32 and server computer can join the same router for local-network use; internet is not necessary for this scan logger. The current sketch only prints the ESP32's IP address and saves scans to SD. Do not treat an RFID UID as secure authentication or payment: common card UIDs can be copied, and this prototype does not tell the server who tapped or change an order's status. The earlier sketch contained Wi-Fi credentials; rotate that Wi-Fi password if that version was shared or committed, then use local, uncommitted settings for the new one.
