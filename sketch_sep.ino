#include <WiFi.h>
#include <SPI.h>
#include <SD.h>
#include <MFRC522.h>
#include <HTTPClient.h>
const char* wifiName = "YOUR_WIFI_NAME";
const char* wifiPassword = "YOUR_WIFI_PASSWORD";
const char* serverBaseUrl = "http://192.168.1.25:3000";
const char* rfidDeviceToken = "REPLACE_WITH_A_RANDOM_64_CHARACTER_TOKEN";

// Pin map for a common ESP32 DevKit and RC522 reader. microSD is optional.
constexpr uint8_t RFID_SS_PIN = 4;
constexpr uint8_t RFID_RST_PIN = 21;
constexpr uint8_t SD_CS_PIN = 27;
constexpr uint8_t SPI_SCK_PIN = 18;
constexpr uint8_t SPI_MISO_PIN = 19;
constexpr uint8_t SPI_MOSI_PIN = 23;

MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
bool sdReady = false;
bool rfidReady = false;

void connectToWiFi() {
  if (String(wifiName) == "YOUR_WIFI_NAME" || strlen(wifiName) == 0) {
    Serial.println("Wi-Fi not configured. RFID scans can still be read locally.");
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
    Serial.println("\nWi-Fi connection failed. Local RFID reading will continue.");
  }
}

void initializeSdCard() {
  digitalWrite(SD_CS_PIN, HIGH);
  if (!SD.begin(SD_CS_PIN, SPI, 4000000)) {
    sdReady = false;
    Serial.println("microSD not available. Continuing without a local scan log.");
    return;
  }

  sdReady = true;
  if (!SD.exists("/rfid_scans.csv")) {
    File logFile = SD.open("/rfid_scans.csv", FILE_WRITE);
    if (!logFile) {
      sdReady = false;
      Serial.println("microSD log could not be created. Continuing without a local scan log.");
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
    Serial.println("No microSD log; scan will still be sent to the cafeteria server when Wi-Fi is connected.");
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

void sendCardScanToServer(const String& uid) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("RFID server unavailable: ESP32 is not connected to Wi-Fi.");
    return;
  }
  if (String(rfidDeviceToken) == "REPLACE_WITH_A_RANDOM_64_CHARACTER_TOKEN" ||
      strlen(rfidDeviceToken) < 32) {
    Serial.println("RFID server unavailable: configure a private device token in the sketch.");
    return;
  }

  HTTPClient client;
  String endpoint = String(serverBaseUrl) + "/api/rfid/scan";
  if (!client.begin(endpoint)) {
    Serial.println("ERROR: Could not connect to the cafeteria server URL.");
    return;
  }
  client.addHeader("Content-Type", "application/json");
  client.addHeader("X-RFID-Token", rfidDeviceToken);
  int status = client.POST("{\"uid\":\"" + uid + "\"}");
  String response = client.getString();
  client.end();

  Serial.print("RFID server response (HTTP ");
  Serial.print(status);
  Serial.print("): ");
  Serial.println(response);
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

  Serial.println(sdReady
    ? "microSD logging enabled."
    : "microSD logging disabled; server features do not require an SD card.");
  Serial.println("Demo reader: linked cards can pay one pending test order or identify a student for staff order lookup.");
  Serial.println("RFID UIDs can be copied. Do not use this prototype with real funds or as secure authentication.");
}

void loop() {
  if (rfidReady && rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uid = readCardUid();
    Serial.print("Card UID: ");
    Serial.println(uid);
    logCardScan(uid);
    sendCardScanToServer(uid);

    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
  }

  delay(50);
}
