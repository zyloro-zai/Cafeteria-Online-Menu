#include <WiFi.h>
#include <SPI.h>
#include <SD.h>
#include <MFRC522.h>

const char* wifiName = "YOUR_WIFI_NAME";
const char* wifiPassword = "YOUR_WIFI_PASSWORD";

// Pin map for a common ESP32 DevKit, RC522 reader, and SPI microSD module.
constexpr uint8_t RFID_SS_PIN = 21;
constexpr uint8_t RFID_RST_PIN = 22;
constexpr uint8_t SD_CS_PIN = 27;
constexpr uint8_t SPI_SCK_PIN = 18;
constexpr uint8_t SPI_MISO_PIN = 19;
constexpr uint8_t SPI_MOSI_PIN = 23;

MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
bool sdReady = false;
bool rfidReady = false;

void connectToWiFi() {
  if (String(wifiName) == "YOUR_WIFI_NAME" || strlen(wifiName) == 0) {
    Serial.println("Wi-Fi not configured. RFID scans will still be logged to the SD card.");
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiName, wifiPassword);

  Serial.print("Connecting to Wi-Fi");
  unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 20000) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nConnected to Wi-Fi.");
    Serial.print("ESP32 IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWi-Fi connection failed. Local RFID and SD logging will continue.");
  }
}

void initializeSdCard() {
  digitalWrite(SD_CS_PIN, HIGH);
  if (!SD.begin(SD_CS_PIN, SPI, 4000000)) {
    Serial.println("ERROR: microSD initialization failed. Check the wiring, card format, and module voltage.");
    return;
  }

  sdReady = true;
  if (!SD.exists("/rfid_scans.csv")) {
    File logFile = SD.open("/rfid_scans.csv", FILE_WRITE);
    if (!logFile) {
      sdReady = false;
      Serial.println("ERROR: Could not create /rfid_scans.csv on the SD card.");
      return;
    }
    logFile.println("uptime_ms,card_uid");
    logFile.close();
  }

  Serial.println("microSD ready. Scan log: /rfid_scans.csv");
}

String readCardUid() {
  String uid;
  for (byte index = 0; index < rfid.uid.size; index++) {
    if (rfid.uid.uidByte[index] < 0x10) {
      uid += "0";
    }
    uid += String(rfid.uid.uidByte[index], HEX);
  }
  uid.toUpperCase();
  return uid;
}

void logCardScan(const String& uid) {
  if (!sdReady) {
    Serial.println("WARNING: Scan was read but not saved because the SD card is unavailable.");
    return;
  }

  File logFile = SD.open("/rfid_scans.csv", FILE_APPEND);
  if (!logFile) {
    Serial.println("ERROR: Could not open /rfid_scans.csv. This scan was not saved.");
    return;
  }

  size_t bytesWritten = logFile.println(String(millis()) + "," + uid);
  logFile.flush();
  logFile.close();

  if (bytesWritten == 0) {
    Serial.println("ERROR: Could not write the RFID scan to the SD card.");
    return;
  }

  Serial.println("Scan saved to SD.");
}

void setup() {
  Serial.begin(115200);
  delay(500);

  connectToWiFi();

  pinMode(RFID_SS_PIN, OUTPUT);
  pinMode(SD_CS_PIN, OUTPUT);
  digitalWrite(RFID_SS_PIN, HIGH);
  digitalWrite(SD_CS_PIN, HIGH);

  SPI.begin(SPI_SCK_PIN, SPI_MISO_PIN, SPI_MOSI_PIN);
  initializeSdCard();

  rfid.PCD_Init();
  byte version = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  if (version == 0x00 || version == 0xFF) {
    Serial.println("ERROR: RC522 not detected. Check its power and SPI wiring.");
  } else {
    rfidReady = true;
    Serial.println("RC522 ready. Tap a compatible card or key fob.");
  }

  Serial.println("This sketch only reads card UIDs and logs scans. It does not charge wallets or verify pickup.");
}

void loop() {
  if (rfidReady && rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uid = readCardUid();
    Serial.print("Card UID: ");
    Serial.println(uid);
    logCardScan(uid);

    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
  }

  delay(50);
}
