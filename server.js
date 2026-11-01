    const http = require("http");
    const https = require("https");
    const fs = require("fs");
    const path = require("path");
    const {randomUUID,randomBytes,timingSafeEqual} = require("crypto");
    const {promisify} = require("util");
    const mammoth = require("mammoth");
    const pdfParse = require("pdf-parse");
    const JSZip = require("jszip");
    const {Pool} = require("pg");

    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || "0.0.0.0";
    const root = __dirname;
    const dataFile = path.resolve(root, process.env.CAFETERIA_DATA_FILE || "server-data.json");
    const databaseUrl = process.env.DATABASE_URL;
    const database = databaseUrl ? new Pool({connectionString:databaseUrl,ssl:{rejectUnauthorized:false}}) : null;
    const scrypt = promisify(require("crypto").scrypt);
    const sessions = new Map();
    const loginAttempts = new Map();
    const registrationAttempts = new Map();
    const sessionDurationMs = 8 * 60 * 60 * 1000;
    let walletWriteQueue = Promise.resolve();
    let pendingRfidEnrollment = null;
    let rfidScanEventId = 0;
    const rfidScanEvents = [];
    const recentRfidScans = new Map();
    const singleOrderCanteen = "Campus Canteen";
    const orderCanteens = new Set([singleOrderCanteen,"Canteen 1","Canteen 2","Campus Cafe"]);
    const orderMenu = new Map([
        [1,{name:"Chicken Adobo + Rice",price:20}],
        [2,{name:"Beef Broccoli Bowl",price:20}],
        [3,{name:"Pork BBQ + Rice",price:18}],
        [4,{name:"Spaghetti",price:18}],
        [5,{name:"Iced Coffee",price:15}],
        [6,{name:"Milk Tea",price:18}],
        [7,{name:"Fruit Shake",price:20}],
        [8,{name:"Fresh Lemonade",price:12}],
        [9,{name:"Cheeseburger",price:20}],
        [10,{name:"French Fries",price:15}],
        [11,{name:"Pancakes",price:18}],
        [12,{name:"Fruit Parfait",price:20}]
    ]);

    function readData(){
        try{
            let data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
            data.accounts = data.accounts || {};
            data.tests = Array.isArray(data.tests) ? data.tests : [];
            data.orders = Array.isArray(data.orders) ? data.orders : [];
            data.walletUsers = data.walletUsers || {};
            data.walletTransactions = Array.isArray(data.walletTransactions) ? data.walletTransactions : [];
            data.rfidCards = data.rfidCards || {};
            data.staffRequests = Array.isArray(data.staffRequests) ? data.staffRequests : [];
            return data;
        }catch(error){
            if(error.code === "ENOENT"){
                return {accounts:{},tests:[],orders:[],walletUsers:{},walletTransactions:[],rfidCards:{},staffRequests:[]};
            }
            throw new Error("Could not read cafeteria data storage: " + error.message);
        }
    }

    function writeData(data){
        let temporaryFile = dataFile + "." + process.pid + ".tmp";
        fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), {mode:0o600});
        fs.renameSync(temporaryFile,dataFile);
    }

    async function initializeDatabase(){
        if(!database){return;}
        await database.query("CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value JSONB NOT NULL)");
        let seed = readData();
        seed.walletUsers = seed.walletUsers || {};
        seed.walletTransactions = Array.isArray(seed.walletTransactions) ? seed.walletTransactions : [];
        seed.rfidCards = seed.rfidCards || {};
        seed.staffRequests = Array.isArray(seed.staffRequests) ? seed.staffRequests : [];
        for(let key of ["accounts","tests","orders","walletUsers","walletTransactions","rfidCards","staffRequests"]){
            await database.query("INSERT INTO app_state (key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING",[key,JSON.stringify(seed[key])]);
        }
    }

    async function getData(){
        if(!database){return readData();}
        let result = await database.query("SELECT key,value FROM app_state WHERE key IN ('accounts','tests','orders','walletUsers','walletTransactions','rfidCards','staffRequests')");
        let data = {accounts:{},tests:[],orders:[],walletUsers:{},walletTransactions:[],rfidCards:{},staffRequests:[]};
        for(let row of result.rows){data[row.key] = row.value;}
        return data;
    }

    async function saveData(data){
        if(!database){
            let operation = walletWriteQueue.then(function(){
                let current = readData();
                current.accounts = data.accounts || {};
                current.tests = Array.isArray(data.tests) ? data.tests : [];
                writeData(current);
            });
            walletWriteQueue = operation.then(function(){},function(){});
            return operation;
        }
        await database.query("INSERT INTO app_state (key,value) VALUES ('accounts',$1),('tests',$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify(data.accounts),JSON.stringify(data.tests)]);
    }

    async function mutateWalletData(work,includeOrders){
        let keys = includeOrders
            ? ["walletUsers","walletTransactions","orders","rfidCards","staffRequests"]
            : ["walletUsers","walletTransactions","rfidCards","staffRequests"];
        if(database){
            let client = await database.connect();
            try{
                await client.query("BEGIN");
                let result = await client.query("SELECT key,value FROM app_state WHERE key = ANY($1::text[]) FOR UPDATE",[keys]);
                let data = {walletUsers:{},walletTransactions:[],orders:[],rfidCards:{},staffRequests:[]};
                for(let row of result.rows){data[row.key] = row.value;}
                let response = await work(data);
                for(let key of keys){
                    await client.query("UPDATE app_state SET value=$1 WHERE key=$2",[JSON.stringify(data[key]),key]);
                }
                await client.query("COMMIT");
                return response;
            }catch(error){
                await client.query("ROLLBACK");
                throw error;
            }finally{
                client.release();
            }
        }

        let operation = walletWriteQueue.then(async function(){
            let data = readData();
            let result = await work(data);
            writeData(data);
            return result;
        });
        walletWriteQueue = operation.then(function(){},function(){});
        return operation;
    }

    function normalizeUserId(value){
        return typeof value === "string" ? value.trim().toLowerCase() : "";
    }

    function validateUserId(value){
        return typeof value === "string" && /^[a-zA-Z0-9._-]{2,32}$/.test(value.trim());
    }

    function validatePassword(value){
        return typeof value === "string" && value.length >= 12 && value.length <= 128;
    }

    function walletBalanceCents(user){
        let balance = user.balanceCents;
        if(!Number.isSafeInteger(balance) || balance < 0){
            throw new Error("Wallet balance data is invalid for this account.");
        }
        return balance;
    }

    async function hashPassword(password){
        let salt = randomBytes(16);
        let hash = await scrypt(password,salt,64);
        return {salt:salt.toString("hex"),passwordHash:Buffer.from(hash).toString("hex")};
    }

    async function passwordMatches(password,user){
        try{
            let salt = Buffer.from(user.salt,"hex");
            let expected = Buffer.from(user.passwordHash,"hex");
            let actual = Buffer.from(await scrypt(password,salt,64));
            return expected.length === actual.length && timingSafeEqual(expected,actual);
        }catch(error){
            return false;
        }
    }

    function walletUserResponse(user){
        return {id:user.id,role:user.role,balance:walletBalanceCents(user) / 100};
    }

    function portalRoleFromRequest(request){
        let role = new URL(request.url,"http://" + (request.headers.host || "localhost")).searchParams.get("role");
        return role === "student" || role === "staff" ? role : null;
    }

    function readSessionToken(request,role){
        let cookie = request.headers.cookie || "";
        let cookieName = role === "student" || role === "staff" ? "cafeteria_" + role + "_session" : "";
        let match = cookieName
            ? cookie.match(new RegExp("(?:^|;\\s*)" + cookieName + "=([a-f0-9]{64})(?:;|$)","i"))
            : null;
        if(!match){
            match = cookie.match(/(?:^|;\s*)cafeteria_session=([a-f0-9]{64})(?:;|$)/i);
        }
        return match ? match[1] : "";
    }

    function getSession(request,role){
        let token = readSessionToken(request,role || portalRoleFromRequest(request));
        let session = token ? sessions.get(token) : null;
        if(session && session.expiresAt <= Date.now()){
            sessions.delete(token);
            session = null;
        }
        return session ? {token:token,...session} : null;
    }

    function requireRole(request,response,role){
        let session = getSession(request,role || portalRoleFromRequest(request));
        if(!session){
            sendJson(response,401,{error:"Please sign in to continue."});
            return null;
        }
        if(role && session.role !== role){
            sendJson(response,403,{error:"You do not have permission to do that."});
            return null;
        }
        return session;
    }

    function setSessionCookie(response,token,role){
        let cookieName = role === "student" || role === "staff" ? "cafeteria_" + role + "_session" : "cafeteria_session";
        let secure = process.env.NODE_ENV === "production" || process.env.TLS_CERT_FILE ? "; Secure" : "";
        response.setHeader("Set-Cookie",cookieName + "=" + token + "; HttpOnly; Path=/; SameSite=Strict; Max-Age=" + Math.floor(sessionDurationMs / 1000) + secure);
    }

    function clearSessionCookie(response,role){
        let cookieName = role === "student" || role === "staff" ? "cafeteria_" + role + "_session" : "cafeteria_session";
        let secure = process.env.NODE_ENV === "production" || process.env.TLS_CERT_FILE ? "; Secure" : "";
        response.setHeader("Set-Cookie",cookieName + "=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0" + secure);
    }

    async function ensureBootstrapStaff(){
        let staffId = process.env.BOOTSTRAP_STAFF_ID || "";
        let password = process.env.BOOTSTRAP_STAFF_PASSWORD || "";
        if(!staffId && !password){
            console.warn("Wallet sign-in is disabled until BOOTSTRAP_STAFF_ID and BOOTSTRAP_STAFF_PASSWORD are configured.");
            return;
        }
        if(!validateUserId(staffId) || !validatePassword(password)){
            throw new Error("Set BOOTSTRAP_STAFF_ID to a 2-32 character ID and BOOTSTRAP_STAFF_PASSWORD to a password of 12-128 characters.");
        }
        let normalizedId = normalizeUserId(staffId);
        await mutateWalletData(async function(data){
            let existing = data.walletUsers[normalizedId];
            if(existing){
                if(existing.role !== "staff"){
                    throw new Error("BOOTSTRAP_STAFF_ID is already assigned to a student account.");
                }
                return;
            }
            let credentials = await hashPassword(password);
            data.walletUsers[normalizedId] = {
                id:staffId.trim(),
                role:"staff",
                balanceCents:0,
                salt:credentials.salt,
                passwordHash:credentials.passwordHash,
                createdAt:new Date().toISOString()
            };
        },false);
    }

    async function getOrders(){
        let orders;
        if(!database){
            orders = readData().orders;
        }else{
            let result = await database.query("SELECT value FROM app_state WHERE key='orders'");
            orders = result.rows.length ? result.rows[0].value : [];
        }
        return orders.map(function(order){
            return {...order,canteen:singleOrderCanteen};
        }).sort(function(left,right){return right.createdAt.localeCompare(left.createdAt);});
    }

    async function updateOrderStatus(orderId,nextStatus){
        if(!["Preparing","Ready","Completed"].includes(nextStatus)){
            throw new OrderValidationError("Choose a valid next order status.");
        }

        if(database){
            let client = await database.connect();
            try{
                await client.query("BEGIN");
                let result = await client.query("SELECT value FROM app_state WHERE key='orders' FOR UPDATE");
                let orders = result.rows.length ? result.rows[0].value : [];
                let order = orders.find(function(entry){return entry.id === orderId;});
                if(!order){
                    let error = new Error("Order not found.");
                    error.statusCode = 404;
                    throw error;
                }
                if(order.status === "New" && order.paymentStatus !== "paid"){
                    let error = new Error("This legacy order has no confirmed campus-credit payment.");
                    error.statusCode = 409;
                    throw error;
                }
                let validNextStatus = order.status === "New" ? "Preparing" :
                    order.status === "Preparing" ? "Ready" :
                    order.status === "Ready" ? "Completed" : null;
                if(order.status === "Awaiting payment"){
                    let error = new Error("This order is awaiting RFID payment.");
                    error.statusCode = 409;
                    throw error;
                }
                if(validNextStatus !== nextStatus){
                    let error = new Error("Order status has changed. Refresh the order list and try again.");
                    error.statusCode = 409;
                    throw error;
                }
                order.status = nextStatus;
                order.canteen = singleOrderCanteen;
                await client.query("UPDATE app_state SET value=$1 WHERE key='orders'",[JSON.stringify(orders)]);
                await client.query("COMMIT");
                return order;
            }catch(error){
                await client.query("ROLLBACK");
                throw error;
            }finally{
                client.release();
            }
        }

        return mutateWalletData(function(data){
            let order = data.orders.find(function(entry){return entry.id === orderId;});
            if(!order){
                let error = new Error("Order not found.");
                error.statusCode = 404;
                throw error;
            }
            if(order.status === "New" && order.paymentStatus !== "paid"){
                let error = new Error("This legacy order has no confirmed campus-credit payment.");
                error.statusCode = 409;
                throw error;
            }
            let validNextStatus = order.status === "New" ? "Preparing" :
                order.status === "Preparing" ? "Ready" :
                order.status === "Ready" ? "Completed" : null;
            if(order.status === "Awaiting payment"){
                let error = new Error("This order is awaiting RFID payment.");
                error.statusCode = 409;
                throw error;
            }
            if(validNextStatus !== nextStatus){
                let error = new Error("Order status has changed. Refresh the order list and try again.");
                error.statusCode = 409;
                throw error;
            }
            order.status = nextStatus;
            order.canteen = singleOrderCanteen;
            return order;
        },true);
    }

    class OrderValidationError extends Error {}

    function createOrder(payload,student){
        if(!payload || typeof payload !== "object" || Array.isArray(payload)){
            throw new OrderValidationError("Order data must be an object.");
        }
        if(!orderCanteens.has(payload.canteen)){
            throw new OrderValidationError("Choose a valid canteen.");
        }
        if(!Array.isArray(payload.items) || payload.items.length === 0 || payload.items.length > orderMenu.size){
            throw new OrderValidationError("Add at least one valid menu item.");
        }
        if(typeof payload.specialRequest !== "string" || payload.specialRequest.length > 160){
            throw new OrderValidationError("Special request must be 160 characters or fewer.");
        }
        let pickupTime = null;
        if(payload.pickupTime !== undefined && payload.pickupTime !== null && payload.pickupTime !== ""){
            if(typeof payload.pickupTime !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.pickupTime)){
                throw new OrderValidationError("Choose a valid pickup time.");
            }
            let pickupTimeMs = Date.parse(payload.pickupTime);
            let now = Date.now();
            if(!Number.isFinite(pickupTimeMs) || pickupTimeMs < now + 5 * 60 * 1000 || pickupTimeMs > now + 24 * 60 * 60 * 1000){
                throw new OrderValidationError("Pickup time must be between 5 minutes and 24 hours from now.");
            }
            pickupTime = new Date(pickupTimeMs).toISOString();
        }

        let seenItems = new Set();
        let items = payload.items.map(function(entry){
            if(!entry || !Number.isInteger(entry.id) || !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 20){
                throw new OrderValidationError("Each item must have a valid ID and a quantity between 1 and 20.");
            }
            let menuItem = orderMenu.get(entry.id);
            if(!menuItem || seenItems.has(entry.id)){
                throw new OrderValidationError("Order contains an unknown or duplicate menu item.");
            }
            seenItems.add(entry.id);
            return {
                id:entry.id,
                name:menuItem.name,
                price:menuItem.price,
                quantity:entry.quantity,
                lineTotal:menuItem.price * entry.quantity
            };
        });
        let subtotal = items.reduce(function(total,item){return total + item.lineTotal;},0);
        let serviceFee = Math.round(subtotal * 5) / 100;
        let id = randomUUID();

        return {
            id:id,
            orderNumber:"CAF-" + id.slice(0,8).toUpperCase(),
            canteen:singleOrderCanteen,
            items:items,
            subtotal:subtotal,
            serviceFee:serviceFee,
            total:subtotal + serviceFee,
            studentId:student.id,
            paymentMethod:"Campus credit",
            paymentStatus:"paid",
            status:"New",
            specialRequest:payload.specialRequest.trim(),
            pickupTime:pickupTime,
            createdAt:new Date().toISOString()
        };
    }

    function amountToCents(value){
        let amount = typeof value === "number" ? String(value) : value;
        if(typeof amount !== "string" || !/^\d{1,6}(?:\.\d{1,2})?$/.test(amount.trim())){
            throw new OrderValidationError("Enter an amount with up to two decimal places.");
        }
        let cents = Math.round(Number(amount) * 100);
        if(!Number.isSafeInteger(cents) || cents < 1 || cents > 5000000){
            throw new OrderValidationError("Credit must be between ₱0.01 and ₱50,000.00.");
        }
        return cents;
    }

    async function createWalletOrder(payload,student){
        let order = createOrder(payload,student);
        let totalCents = Math.round(order.total * 100);
        return mutateWalletData(function(data){
            let user = data.walletUsers[normalizeUserId(student.id)];
            if(!user || user.role !== "student"){
                let error = new Error("Student account is no longer available. Sign in again.");
                error.statusCode = 401;
                throw error;
            }
            let balanceCents = walletBalanceCents(user);
            if(balanceCents < totalCents){
                let error = new Error("Insufficient campus credit. Add credit through staff before placing this order.");
                error.statusCode = 402;
                error.balance = balanceCents / 100;
                error.required = totalCents / 100;
                throw error;
            }
            user.balanceCents = balanceCents - totalCents;
            data.orders = Array.isArray(data.orders) ? data.orders : [];
            data.orders.push(order);
            data.walletTransactions = Array.isArray(data.walletTransactions) ? data.walletTransactions : [];
            data.walletTransactions.push({
                id:randomUUID(),
                studentId:user.id,
                type:"debit",
                amountCents:totalCents,
                balanceAfterCents:user.balanceCents,
                orderNumber:order.orderNumber,
                createdAt:order.createdAt
            });
            return {order:order,balance:user.balanceCents / 100};
        },true);
    }

    async function createRfidPendingOrder(payload,student){
        let order = createOrder(payload,student);
        order.paymentMethod = "RFID campus credit";
        order.paymentStatus = "awaiting_payment";
        order.status = "Awaiting payment";
        return mutateWalletData(function(data){
            let user = data.walletUsers[normalizeUserId(student.id)];
            if(!user || user.role !== "student"){
                let error = new Error("Student account is no longer available. Sign in again.");
                error.statusCode = 401;
                throw error;
            }
            if(!Object.values(data.rfidCards).some(function(owner){
                return normalizeUserId(owner) === normalizeUserId(user.id);
            })){
                let error = new Error("Ask staff to link your RFID card before creating an RFID payment order.");
                error.statusCode = 409;
                throw error;
            }
            data.orders = Array.isArray(data.orders) ? data.orders : [];
            let existingOrder = data.orders.find(function(entry){
                return normalizeUserId(entry.studentId) === normalizeUserId(user.id) &&
                    entry.status === "Awaiting payment" && entry.paymentStatus === "awaiting_payment";
            });
            if(existingOrder){
                let error = new Error("Pay for your existing RFID order before creating another one.");
                error.statusCode = 409;
                throw error;
            }
            data.orders.push(order);
            return {order:order,balance:walletBalanceCents(user) / 100};
        },true);
    }

    function recordRfidScanEvent(result){
        let event = {id:++rfidScanEventId,...result,createdAt:new Date().toISOString()};
        rfidScanEvents.push(event);
        if(rfidScanEvents.length > 50){rfidScanEvents.shift();}
        return event;
    }

    function normalizeCardUid(value){
        if(typeof value !== "string"){return "";}
        let uid = value.trim().toUpperCase();
        return /^(?:[0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$/.test(uid) ? uid : "";
    }

    function hasValidRfidDeviceToken(request){
        let expected = process.env.RFID_DEVICE_TOKEN || "";
        let supplied = request.headers["x-rfid-token"];
        if(expected.length < 32 || typeof supplied !== "string"){return false;}
        let expectedBytes = Buffer.from(expected);
        let suppliedBytes = Buffer.from(supplied);
        return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes,suppliedBytes);
    }

    async function processRfidScan(uid){
        let enrollment = pendingRfidEnrollment;
        if(enrollment && enrollment.expiresAt <= Date.now()){
            pendingRfidEnrollment = null;
            enrollment = null;
        }
        if(enrollment){pendingRfidEnrollment = null;}

        let result = await mutateWalletData(function(data){
            if(enrollment){
                let student = data.walletUsers[normalizeUserId(enrollment.studentId)];
                if(!student || student.role !== "student"){
                    return {kind:"enrollment_failed",studentId:enrollment.studentId,message:"Student account is no longer available."};
                }
                let existingStudentCard = Object.entries(data.rfidCards).find(function(entry){
                    return normalizeUserId(entry[1]) === normalizeUserId(student.id);
                });
                let existingCardOwner = data.rfidCards[uid];
                if(existingCardOwner && normalizeUserId(existingCardOwner) !== normalizeUserId(student.id)){
                    return {kind:"enrollment_failed",studentId:student.id,message:"This card is already linked to another student."};
                }
                if(existingStudentCard && existingStudentCard[0] !== uid){
                    return {kind:"enrollment_failed",studentId:student.id,message:"This student already has a linked card. Unlink it before enrolling a replacement."};
                }
                data.rfidCards[uid] = student.id;
                return {kind:"enrolled",studentId:student.id};
            }

            let studentId = data.rfidCards[uid];
            let student = studentId ? data.walletUsers[normalizeUserId(studentId)] : null;
            if(!student || student.role !== "student"){
                return {kind:"unrecognized"};
            }
            let pendingOrders = (Array.isArray(data.orders) ? data.orders : []).filter(function(order){
                return normalizeUserId(order.studentId) === normalizeUserId(student.id) &&
                    order.status === "Awaiting payment" && order.paymentStatus === "awaiting_payment";
            });
            if(pendingOrders.length > 1){
                return {kind:"payment_failed",studentId:student.id,message:"More than one unpaid RFID order exists. Ask staff to review the orders."};
            }
            if(pendingOrders.length === 1){
                let order = pendingOrders[0];
                let amountCents = Math.round(order.total * 100);
                let balanceCents = walletBalanceCents(student);
                if(balanceCents < amountCents){
                    return {
                        kind:"payment_failed",
                        studentId:student.id,
                        message:"Insufficient campus credit. Add test credit through the staff portal.",
                        orderNumber:order.orderNumber,
                        balance:balanceCents / 100,
                        required:amountCents / 100
                    };
                }
                student.balanceCents = balanceCents - amountCents;
                order.paymentStatus = "paid";
                order.status = "New";
                order.paymentMethod = "Campus credit (RFID demo)";
                order.paidAt = new Date().toISOString();
                data.walletTransactions = Array.isArray(data.walletTransactions) ? data.walletTransactions : [];
                data.walletTransactions.push({
                    id:randomUUID(),
                    studentId:student.id,
                    type:"debit",
                    amountCents:amountCents,
                    balanceAfterCents:student.balanceCents,
                    orderNumber:order.orderNumber,
                    paymentMethod:"RFID demo",
                    createdAt:order.paidAt
                });
                return {
                    kind:"paid",
                    studentId:student.id,
                    orderNumber:order.orderNumber,
                    balance:student.balanceCents / 100
                };
            }

            let studentOrders = (Array.isArray(data.orders) ? data.orders : [])
                .filter(function(order){return normalizeUserId(order.studentId) === normalizeUserId(student.id);})
                .sort(function(left,right){return right.createdAt.localeCompare(left.createdAt);})
                .slice(0,20)
                .map(function(order){
                    return {id:order.id,orderNumber:order.orderNumber,status:order.status,paymentStatus:order.paymentStatus};
                });
            return {kind:"identified",studentId:student.id,orders:studentOrders};
        },true);

        if(result.kind === "enrollment_failed"){
            recordRfidScanEvent({kind:result.kind,studentId:result.studentId,message:result.message});
        }else if(result.kind === "identified" || result.kind === "paid"){
            recordRfidScanEvent({...result,orders:result.orders || []});
        }else if(result.kind === "payment_failed"){
            recordRfidScanEvent({kind:result.kind,studentId:result.studentId,message:result.message,orderNumber:result.orderNumber});
        }else if(result.kind === "unrecognized"){
            recordRfidScanEvent({kind:result.kind});
        }else if(result.kind === "enrolled"){
            recordRfidScanEvent({kind:result.kind,studentId:result.studentId});
        }
        return result;
    }

    async function createWalletAccount(accountId,password,role){
        if(!validateUserId(accountId)){
            throw new OrderValidationError("Account ID must be 2-32 letters, numbers, dots, hyphens, or underscores.");
        }
        if(!validatePassword(password)){
            throw new OrderValidationError("Set a password that is 12-128 characters long.");
        }
        let credentials = await hashPassword(password);
        return mutateWalletData(function(data){
            let normalizedId = normalizeUserId(accountId);
            if(data.walletUsers[normalizedId]){
                throw new OrderValidationError("That account ID is already in use.");
            }
            if(data.staffRequests.some(function(entry){
                return normalizeUserId(entry.staffId) === normalizedId;
            })){
                throw new OrderValidationError("That account ID has a pending staff registration request.");
            }
            let user = {
                id:accountId.trim(),
                role:role,
                balanceCents:0,
                salt:credentials.salt,
                passwordHash:credentials.passwordHash,
                createdAt:new Date().toISOString()
            };
            data.walletUsers[normalizedId] = user;
            return walletUserResponse(user);
        },false);
    }

    function createStudentAccount(studentId,password){
        return createWalletAccount(studentId,password,"student");
    }

    function createStaffAccount(staffId,password){
        return createWalletAccount(staffId,password,"staff");
    }

    async function createStaffRequest(staffId,password){
        if(!validateUserId(staffId)){
            throw new OrderValidationError("Staff ID must be 2-32 letters, numbers, dots, hyphens, or underscores.");
        }
        if(!validatePassword(password)){
            throw new OrderValidationError("Set a password that is 12-128 characters long.");
        }
        let credentials = await hashPassword(password);
        return mutateWalletData(function(data){
            let normalizedId = normalizeUserId(staffId);
            let alreadyRequested = data.staffRequests.some(function(entry){
                return normalizeUserId(entry.staffId) === normalizedId;
            });
            if(data.walletUsers[normalizedId] || alreadyRequested){
                let error = new Error("That staff ID already exists or has a pending request.");
                error.statusCode = 409;
                throw error;
            }
            let request = {
                id:randomUUID(),
                staffId:staffId.trim(),
                salt:credentials.salt,
                passwordHash:credentials.passwordHash,
                createdAt:new Date().toISOString()
            };
            data.staffRequests.push(request);
            return {id:request.id,staffId:request.staffId,status:"pending"};
        },false);
    }

    async function reviewStaffRequest(requestId,decision,reviewedBy){
        return mutateWalletData(function(data){
            let index = data.staffRequests.findIndex(function(entry){return entry.id === requestId;});
            if(index < 0){
                let error = new Error("Staff registration request not found.");
                error.statusCode = 404;
                throw error;
            }
            let request = data.staffRequests[index];
            data.staffRequests.splice(index,1);
            if(decision === "approve"){
                let normalizedId = normalizeUserId(request.staffId);
                if(data.walletUsers[normalizedId]){
                    let error = new Error("This staff ID was assigned to another account. Reject this request and ask the applicant to choose a different ID.");
                    error.statusCode = 409;
                    throw error;
                }
                data.walletUsers[normalizedId] = {
                    id:request.staffId,
                    role:"staff",
                    balanceCents:0,
                    salt:request.salt,
                    passwordHash:request.passwordHash,
                    createdAt:request.createdAt,
                    approvedAt:new Date().toISOString(),
                    approvedBy:reviewedBy
                };
                return {staffId:request.staffId,decision:"approved"};
            }
            return {staffId:request.staffId,decision:"rejected"};
        },false);
    }

    function allowRegistration(request,response){
        let key = request.socket.remoteAddress || "unknown";
        let now = Date.now();
        let attempts = registrationAttempts.get(key);
        if(!attempts || now - attempts.startedAt >= 60 * 60 * 1000){
            attempts = {count:0,startedAt:now};
        }
        if(attempts.count >= 5){
            sendJson(response,429,{error:"Too many account registration attempts. Try again in an hour."});
            return false;
        }
        attempts.count += 1;
        registrationAttempts.set(key,attempts);
        return true;
    }

    async function addWalletCredit(studentId,amount,reference,staffId){
        if(!validateUserId(studentId)){
            throw new OrderValidationError("Enter a valid student ID.");
        }
        if(typeof reference !== "string" || !reference.trim() || reference.trim().length > 100){
            throw new OrderValidationError("Enter a receipt or verification reference (100 characters or fewer).");
        }
        let amountCents = amountToCents(amount);
        return mutateWalletData(function(data){
            let user = data.walletUsers[normalizeUserId(studentId)];
            if(!user || user.role !== "student"){
                throw new OrderValidationError("No student account exists for that ID.");
            }
            let existingReference = (Array.isArray(data.walletTransactions) ? data.walletTransactions : []).some(function(entry){
                return entry.type === "credit" &&
                    normalizeUserId(entry.studentId) === normalizeUserId(user.id) &&
                    entry.reference === reference.trim();
            });
            if(existingReference){
                throw new OrderValidationError("That receipt reference has already been recorded for this student.");
            }
            let newBalance = walletBalanceCents(user) + amountCents;
            if(!Number.isSafeInteger(newBalance)){
                throw new Error("The resulting wallet balance exceeds the supported limit.");
            }
            user.balanceCents = newBalance;
            let transaction = {
                id:randomUUID(),
                studentId:user.id,
                type:"credit",
                amountCents:amountCents,
                balanceAfterCents:user.balanceCents,
                staffId:staffId,
                reference:reference.trim(),
                createdAt:new Date().toISOString()
            };
            data.walletTransactions = Array.isArray(data.walletTransactions) ? data.walletTransactions : [];
            data.walletTransactions.push(transaction);
            return {student:walletUserResponse(user),transaction:transaction};
        },false);
    }

    async function refundWalletOrder(orderId,staffId){
        return mutateWalletData(function(data){
            let order = (Array.isArray(data.orders) ? data.orders : []).find(function(entry){return entry.id === orderId;});
            if(!order){
                let error = new Error("Order not found.");
                error.statusCode = 404;
                throw error;
            }
            if(order.status !== "New" || order.paymentStatus !== "paid"){
                let error = new Error("Only a paid order that has not started preparation can be cancelled and refunded.");
                error.statusCode = 409;
                throw error;
            }
            let user = data.walletUsers[normalizeUserId(order.studentId)];
            if(!user || user.role !== "student"){
                let error = new Error("The student wallet for this order could not be found.");
                error.statusCode = 409;
                throw error;
            }
            let amountCents = Math.round(Number(order.total) * 100);
            let newBalance = walletBalanceCents(user) + amountCents;
            if(!Number.isSafeInteger(newBalance)){
                let error = new Error("The resulting wallet balance exceeds the supported limit.");
                error.statusCode = 409;
                throw error;
            }
            user.balanceCents = newBalance;
            order.status = "Cancelled";
            order.paymentStatus = "refunded";
            order.updatedAt = new Date().toISOString();
            data.walletTransactions = Array.isArray(data.walletTransactions) ? data.walletTransactions : [];
            data.walletTransactions.push({
                id:randomUUID(),
                studentId:user.id,
                type:"refund",
                amountCents:amountCents,
                balanceAfterCents:user.balanceCents,
                staffId:staffId,
                orderNumber:order.orderNumber,
                createdAt:order.updatedAt
            });
            return order;
        },true);
    }

    function sendJson(response,status,data){
        response.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
        response.end(JSON.stringify(data));
    }

    function readBody(request){
        return new Promise(function(resolve,reject){
            let body = "";
            request.on("data",function(chunk){body += chunk;});
            request.on("end",function(){resolve(body);});
            request.on("error",reject);
        });
    }

    function cleanText(text){
        return String(text || "").replace(/\s+/g," ").trim().slice(0,30000);
    }

    async function extractDocumentText(fileName,buffer){
        let extension = path.extname(fileName).toLowerCase();
        if(extension === ".pdf"){
            return cleanText((await pdfParse(buffer)).text);
        }
        if(extension === ".docx"){
            return cleanText((await mammoth.extractRawText({buffer:buffer})).value);
        }
        if(extension === ".pptx"){
            let archive = await JSZip.loadAsync(buffer);
            let slideNames = Object.keys(archive.files).filter(function(name){return /^ppt\/slides\/slide\d+\.xml$/i.test(name);}).sort();
            let text = "";
            for(let name of slideNames){
                let xml = await archive.files[name].async("string");
                text += " " + Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)).map(function(match){return match[1];}).join(" ");
            }
            return cleanText(text);
        }
        throw new Error("Only PDF, DOCX, and PPTX files are supported.");
    }

    function fallbackQuestions(text){
        let sentences = text.split(/[.!?]+/).map(function(value){return value.trim();}).filter(function(value){return value.length > 35;}).slice(0,5);
        return sentences.map(function(sentence,index){
            let words = sentence.split(/\s+/);
            let answer = words[Math.min(3,words.length - 1)];
            let prompt = sentence.replace(answer,"_____ ");
            return {q:"According to the uploaded material, complete this statement: " + prompt,c:[answer,"The opposite idea","A different topic","The material does not say"],a:0};
        });
    }

    async function generateQuestions(text,title){
        if(!process.env.OPENAI_API_KEY){
            try{
                let result = await fetch("http://127.0.0.1:11434/api/generate",{
                    method:"POST",
                    headers:{"Content-Type":"application/json"},
                    body:JSON.stringify({model:process.env.OLLAMA_MODEL || "llama3.2",stream:false,format:"json",prompt:"Create 5 accurate multiple-choice questions from this lesson. Return ONLY a JSON object with a questions array. Each item must have q (string), c (array of exactly 4 strings), and a (number 0-3). Title: " + title + "\nLesson: " + text})
                });
                if(result.ok){
                    let response = await result.json();
                    let parsed = JSON.parse(response.response);
                    if(Array.isArray(parsed.questions) && parsed.questions.length){
                        return {questions:parsed.questions,mode:"ollama",message:"Questions generated locally with Ollama. Review them before publishing."};
                    }
                }
            }catch(error){}
            return {questions:fallbackQuestions(text),mode:"demo",message:"Demo generation used. Start Ollama with a model for local AI questions."};
        }
        let prompt = "Create 5 multiple-choice questions from this lesson. Return ONLY valid JSON as an array. Each item must have q (string), c (array of exactly 4 strings), and a (number 0-3). Title: " + title + "\nLesson: " + text;
        let result = await fetch("https://api.openai.com/v1/chat/completions",{
            method:"POST",
            headers:{"Content-Type":"application/json","Authorization":"Bearer " + process.env.OPENAI_API_KEY},
            body:JSON.stringify({model:process.env.OPENAI_MODEL || "gpt-4o-mini",temperature:0.2,messages:[{role:"system",content:"You create accurate classroom quizzes."},{role:"user",content:prompt}]})
        });
        if(!result.ok){throw new Error("AI service returned " + result.status + ".");}
        let response = await result.json();
        let content = response.choices[0].message.content.replace(/^```json\s*|\s*```$/g,"").trim();
        let questions = JSON.parse(content);
        if(!Array.isArray(questions) || !questions.length){throw new Error("AI returned no questions.");}
        return {questions:questions,mode:"ai",message:"AI-generated questions are ready for review."};
    }

    function serveIndex(response){
        fs.readFile(path.join(root,"student.html"),function(error,content){
            if(error){sendJson(response,500,{error:"Website file is unavailable."});return;}
            response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
            response.end(content);
        });
    }

    async function handleRequest(request,response){
        if(request.method === "OPTIONS"){
            response.writeHead(204);
            response.end();
            return;
        }

        const requestUrl = new URL(request.url, "http://" + (request.headers.host || "localhost"));
        const pathname = requestUrl.pathname;

        if(pathname === "/api/rfid/scan" && request.method === "POST"){
            if((process.env.RFID_DEVICE_TOKEN || "").length < 32){
                sendJson(response,503,{error:"RFID device access is not configured on this demo server."});
                return;
            }
            if(!hasValidRfidDeviceToken(request)){
                sendJson(response,403,{error:"RFID device token is invalid."});
                return;
            }
            try{
                let payload = JSON.parse(await readBody(request));
                let uid = normalizeCardUid(payload && payload.uid);
                if(!uid){
                    sendJson(response,400,{error:"Send a valid RFID card UID."});
                    return;
                }
                let lastScan = recentRfidScans.get(uid) || 0;
                if(Date.now() - lastScan < 1500){
                    sendJson(response,200,{kind:"duplicate",message:"Card scan was already received."});
                    return;
                }
                recentRfidScans.set(uid,Date.now());
                if(recentRfidScans.size > 200){
                    for(let [scannedUid,scannedAt] of recentRfidScans){
                        if(Date.now() - scannedAt > 60000){recentRfidScans.delete(scannedUid);}
                    }
                    while(recentRfidScans.size > 200){
                        recentRfidScans.delete(recentRfidScans.keys().next().value);
                    }
                }
                let result = await processRfidScan(uid);
                let status = result.kind === "unrecognized" ? 404 :
                    result.kind === "payment_failed" ? 402 :
                    result.kind === "enrollment_failed" ? 409 : 200;
                sendJson(response,status,result);
            }catch(error){
                console.error("Could not process RFID card scan:",error.message);
                sendJson(response,error instanceof SyntaxError ? 400 : 500,{error:error instanceof SyntaxError ? "RFID scan data must be valid JSON." : "Could not process RFID card scan."});
            }
            return;
        }

        if(pathname === "/api/rfid/cards" && request.method === "GET"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            let studentId = normalizeUserId(requestUrl.searchParams.get("studentId"));
            if(!studentId){
                sendJson(response,400,{error:"Enter a valid student ID."});
                return;
            }
            try{
                let data = await getData();
                let student = data.walletUsers[studentId];
                if(!student || student.role !== "student"){
                    sendJson(response,404,{error:"Student account not found."});
                    return;
                }
                let linked = Object.values(data.rfidCards).some(function(owner){
                    return normalizeUserId(owner) === studentId;
                });
                sendJson(response,200,{studentId:student.id,linked:linked});
            }catch(error){
                console.error("Could not check RFID card enrollment:",error.message);
                sendJson(response,500,{error:"Could not check RFID card enrollment."});
            }
            return;
        }

        if(pathname === "/api/rfid/enrollment" && request.method === "POST"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            try{
                let payload = JSON.parse(await readBody(request));
                let studentId = normalizeUserId(payload && payload.studentId);
                let data = await getData();
                let student = data.walletUsers[studentId];
                if(!student || student.role !== "student"){
                    sendJson(response,404,{error:"Student account not found."});
                    return;
                }
                if(Object.values(data.rfidCards).some(function(owner){
                    return normalizeUserId(owner) === studentId;
                })){
                    sendJson(response,409,{error:"This student already has a linked card. Unlink it before enrolling a replacement."});
                    return;
                }
                if(pendingRfidEnrollment && pendingRfidEnrollment.expiresAt > Date.now()){
                    sendJson(response,409,{error:"Another card enrollment is already waiting for a scan."});
                    return;
                }
                pendingRfidEnrollment = {studentId:student.id,expiresAt:Date.now() + 120000};
                sendJson(response,200,{studentId:student.id,expiresAt:new Date(pendingRfidEnrollment.expiresAt).toISOString()});
            }catch(error){
                if(error instanceof SyntaxError){
                    sendJson(response,400,{error:"RFID enrollment data must be valid JSON."});
                }else{
                    console.error("Could not start RFID card enrollment:",error.message);
                    sendJson(response,500,{error:"Could not start RFID card enrollment."});
                }
            }
            return;
        }

        if(pathname === "/api/rfid/enrollment" && request.method === "GET"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            if(pendingRfidEnrollment && pendingRfidEnrollment.expiresAt <= Date.now()){
                pendingRfidEnrollment = null;
            }
            sendJson(response,200,{enrollment:pendingRfidEnrollment ? {
                studentId:pendingRfidEnrollment.studentId,
                expiresAt:new Date(pendingRfidEnrollment.expiresAt).toISOString()
            } : null});
            return;
        }

        if(pathname === "/api/rfid/enrollment" && request.method === "DELETE"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            if(pendingRfidEnrollment && pendingRfidEnrollment.expiresAt > Date.now()){
                pendingRfidEnrollment = null;
            }
            sendJson(response,200,{cancelled:true});
            return;
        }

        if(pathname === "/api/rfid/cards" && request.method === "DELETE"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            try{
                let payload = JSON.parse(await readBody(request));
                let studentId = normalizeUserId(payload && payload.studentId);
                if(!studentId){
                    sendJson(response,400,{error:"Enter a valid student ID."});
                    return;
                }
                let unlinked = await mutateWalletData(function(data){
                    let student = data.walletUsers[studentId];
                    if(!student || student.role !== "student"){
                        let error = new Error("Student account not found.");
                        error.statusCode = 404;
                        throw error;
                    }
                    let removed = 0;
                    for(let [uid,owner] of Object.entries(data.rfidCards)){
                        if(normalizeUserId(owner) === studentId){
                            delete data.rfidCards[uid];
                            removed += 1;
                        }
                    }
                    return removed;
                },false);
                sendJson(response,200,{unlinked:unlinked > 0});
            }catch(error){
                if(error instanceof SyntaxError){
                    sendJson(response,400,{error:"RFID card data must be valid JSON."});
                }else if(error.statusCode === 404){
                    sendJson(response,404,{error:error.message});
                }else{
                    console.error("Could not unlink RFID card:",error.message);
                    sendJson(response,500,{error:"Could not unlink RFID card."});
                }
            }
            return;
        }

        if(pathname === "/api/rfid/scans" && request.method === "GET"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            let after = Number(requestUrl.searchParams.get("after") || 0);
            if(!Number.isSafeInteger(after) || after < 0){
                sendJson(response,400,{error:"Scan cursor must be a non-negative integer."});
                return;
            }
            sendJson(response,200,{
                events:rfidScanEvents.filter(function(event){return event.id > after;}),
                latestId:rfidScanEventId
            });
            return;
        }

        if(pathname === "/api/auth/register" && request.method === "POST"){
            if(!allowRegistration(request,response)){return;}
            try{
                let payload = JSON.parse(await readBody(request));
                let student = await createStudentAccount(payload && payload.studentId,payload && payload.password);
                sendJson(response,201,{student:student});
            }catch(error){
                if(error instanceof SyntaxError || error instanceof OrderValidationError){
                    sendJson(response,400,{error:error instanceof SyntaxError ? "Registration data must be valid JSON." : error.message});
                }else{
                    console.error("Could not register student account:",error.message);
                    sendJson(response,error.statusCode || 500,{error:error.statusCode === 409 ? error.message : "Could not create student account."});
                }
            }
            return;
        }

        if(pathname === "/api/auth/staff-requests" && request.method === "POST"){
            if(!allowRegistration(request,response)){return;}
            try{
                let payload = JSON.parse(await readBody(request));
                let requestInfo = await createStaffRequest(payload && payload.staffId,payload && payload.password);
                sendJson(response,202,{request:requestInfo,message:"Your request was submitted. An existing staff member must verify and approve it before you can sign in."});
            }catch(error){
                if(error instanceof SyntaxError || error instanceof OrderValidationError){
                    sendJson(response,400,{error:error instanceof SyntaxError ? "Registration data must be valid JSON." : error.message});
                }else{
                    console.error("Could not submit staff registration request:",error.message);
                    sendJson(response,error.statusCode || 500,{error:error.statusCode === 409 ? error.message : "Could not submit staff registration request."});
                }
            }
            return;
        }

        if(pathname === "/api/auth/login" && request.method === "POST"){
            try{
                let payload = JSON.parse(await readBody(request));
                let normalizedId = normalizeUserId(payload && payload.id);
                let attemptKey = (request.socket.remoteAddress || "unknown") + ":" + normalizedId;
                let attempts = loginAttempts.get(attemptKey);
                if(attempts && attempts.count >= 5 && Date.now() - attempts.startedAt < 10 * 60 * 1000){
                    sendJson(response,429,{error:"Too many sign-in attempts. Wait 10 minutes and try again."});
                    return;
                }
                let data = await getData();
                let user = data.walletUsers[normalizedId];
                if(!user || typeof payload.password !== "string" || !(await passwordMatches(payload.password,user))){
                    if(!attempts || Date.now() - attempts.startedAt >= 10 * 60 * 1000){
                        attempts = {count:0,startedAt:Date.now()};
                    }
                    attempts.count += 1;
                    loginAttempts.set(attemptKey,attempts);
                    sendJson(response,401,{error:"The ID or password is incorrect."});
                    return;
                }
                loginAttempts.delete(attemptKey);
                let token = randomBytes(32).toString("hex");
                sessions.set(token,{id:user.id,role:user.role,expiresAt:Date.now() + sessionDurationMs});
                setSessionCookie(response,token,user.role);
                sendJson(response,200,{user:walletUserResponse(user)});
            }catch(error){
                sendJson(response,error instanceof SyntaxError ? 400 : 500,{error:error instanceof SyntaxError ? "Sign-in data must be valid JSON." : "Could not sign in."});
            }
            return;
        }

        if(pathname === "/api/auth/me" && request.method === "GET"){
            let session = getSession(request,portalRoleFromRequest(request));
            if(!session){
                sendJson(response,200,{user:null});
                return;
            }
            try{
                let data = await getData();
                let user = data.walletUsers[normalizeUserId(session.id)];
                if(!user || user.role !== session.role){
                    sessions.delete(session.token);
                    clearSessionCookie(response,session.role);
                    sendJson(response,401,{error:"This account is no longer available. Sign in again."});
                    return;
                }
                sendJson(response,200,{user:walletUserResponse(user)});
            }catch(error){
                console.error("Could not load cafeteria account:",error.message);
                sendJson(response,500,{error:"Could not load account information."});
            }
            return;
        }

        if(pathname === "/api/auth/logout" && request.method === "POST"){
            let role = portalRoleFromRequest(request);
            let session = getSession(request,role);
            if(session){sessions.delete(session.token);}
            clearSessionCookie(response,session ? session.role : role);
            sendJson(response,200,{signedOut:true});
            return;
        }

        if(pathname === "/api/auth/password" && request.method === "POST"){
            let session = requireRole(request,response,null);
            if(!session){return;}
            try{
                let payload = JSON.parse(await readBody(request));
                if(!validatePassword(payload && payload.newPassword)){
                    throw new OrderValidationError("New password must be 12-128 characters long.");
                }
                let credentials = await hashPassword(payload.newPassword);
                await mutateWalletData(async function(data){
                    let user = data.walletUsers[normalizeUserId(session.id)];
                    if(!user || !(await passwordMatches(payload.currentPassword,user))){
                        let error = new Error("The current password is incorrect.");
                        error.statusCode = 401;
                        throw error;
                    }
                    user.salt = credentials.salt;
                    user.passwordHash = credentials.passwordHash;
                },false);
                for(let [token,otherSession] of sessions){
                    if(token !== session.token && normalizeUserId(otherSession.id) === normalizeUserId(session.id)){
                        sessions.delete(token);
                    }
                }
                sendJson(response,200,{updated:true});
            }catch(error){
                if(error instanceof SyntaxError || error instanceof OrderValidationError){
                    sendJson(response,400,{error:error instanceof SyntaxError ? "Password data must be valid JSON." : error.message});
                }else if(error.statusCode === 401){
                    sendJson(response,401,{error:error.message});
                }else{
                    console.error("Could not change cafeteria account password:",error.message);
                    sendJson(response,500,{error:"Could not change password."});
                }
            }
            return;
        }

        if(pathname === "/api/wallet/students" && request.method === "POST"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            try{
                let payload = JSON.parse(await readBody(request));
                let student = await createStudentAccount(payload && payload.studentId,payload && payload.password);
                sendJson(response,201,{student:student});
            }catch(error){
                if(error instanceof SyntaxError || error instanceof OrderValidationError){
                    sendJson(response,400,{error:error instanceof SyntaxError ? "Student account data must be valid JSON." : error.message});
                }else{
                    console.error("Could not create cafeteria student account:",error.message);
                    sendJson(response,500,{error:"Could not create student account."});
                }
            }
            return;
        }

        if(pathname === "/api/wallet/staff" && request.method === "POST"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            try{
                let payload = JSON.parse(await readBody(request));
                let staff = await createStaffAccount(payload && payload.staffId,payload && payload.password);
                sendJson(response,201,{staff:staff});
            }catch(error){
                if(error instanceof SyntaxError || error instanceof OrderValidationError){
                    sendJson(response,400,{error:error instanceof SyntaxError ? "Staff account data must be valid JSON." : error.message});
                }else{
                    console.error("Could not create cafeteria staff account:",error.message);
                    sendJson(response,500,{error:"Could not create staff account."});
                }
            }
            return;
        }

        if(pathname === "/api/wallet/staff-requests" && request.method === "GET"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            try{
                let data = await getData();
                sendJson(response,200,data.staffRequests.map(function(entry){
                    return {id:entry.id,staffId:entry.staffId,createdAt:entry.createdAt};
                }));
            }catch(error){
                console.error("Could not load staff registration requests:",error.message);
                sendJson(response,500,{error:"Could not load staff registration requests."});
            }
            return;
        }

        let staffRequestMatch = pathname.match(/^\/api\/wallet\/staff-requests\/([0-9a-f-]+)$/i);
        if(staffRequestMatch && request.method === "POST"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            try{
                let payload = JSON.parse(await readBody(request));
                if(!payload || !["approve","reject"].includes(payload.decision)){
                    throw new OrderValidationError("Choose approve or reject for this staff request.");
                }
                let review = await reviewStaffRequest(staffRequestMatch[1],payload.decision,session.id);
                sendJson(response,200,review);
            }catch(error){
                if(error instanceof SyntaxError || error instanceof OrderValidationError){
                    sendJson(response,400,{error:error instanceof SyntaxError ? "Staff request review data must be valid JSON." : error.message});
                }else if(error.statusCode === 404 || error.statusCode === 409){
                    sendJson(response,error.statusCode,{error:error.message});
                }else{
                    console.error("Could not review staff registration request:",error.message);
                    sendJson(response,500,{error:"Could not review staff registration request."});
                }
            }
            return;
        }

        if(pathname === "/api/wallet/topups" && request.method === "POST"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            try{
                let payload = JSON.parse(await readBody(request));
                let result = await addWalletCredit(payload && payload.studentId,payload && payload.amount,payload && payload.reference,session.id);
                sendJson(response,201,result);
            }catch(error){
                if(error instanceof SyntaxError || error instanceof OrderValidationError){
                    sendJson(response,400,{error:error instanceof SyntaxError ? "Credit data must be valid JSON." : error.message});
                }else{
                    console.error("Could not add cafeteria wallet credit:",error.message);
                    sendJson(response,500,{error:"Could not add credit."});
                }
            }
            return;
        }

        if(pathname === "/api/wallet/transactions" && request.method === "GET"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            try{
                let data = await getData();
                let transactions = Array.isArray(data.walletTransactions) ? data.walletTransactions : [];
                sendJson(response,200,transactions.slice(-100).reverse());
            }catch(error){
                console.error("Could not load cafeteria wallet transactions:",error.message);
                sendJson(response,500,{error:"Could not load wallet transactions."});
            }
            return;
        }

        let orderStatusMatch = pathname.match(/^\/api\/orders\/([0-9a-f-]+)\/status$/i);
        let orderCancelMatch = pathname.match(/^\/api\/orders\/([0-9a-f-]+)\/cancel$/i);
        if(orderCancelMatch && request.method === "POST"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            try{
                let order = await refundWalletOrder(orderCancelMatch[1],session.id);
                sendJson(response,200,order);
            }catch(error){
                if(error.statusCode === 404 || error.statusCode === 409){
                    sendJson(response,error.statusCode,{error:error.message});
                }else{
                    console.error("Could not refund cafeteria order:",error.message);
                    sendJson(response,500,{error:"Could not cancel and refund order."});
                }
            }
            return;
        }
        if(orderStatusMatch && request.method === "POST"){
            let session = requireRole(request,response,"staff");
            if(!session){return;}
            try{
                let payload = JSON.parse(await readBody(request));
                if(!payload || typeof payload !== "object" || Array.isArray(payload)){
                    throw new OrderValidationError("Order status data must be an object.");
                }
                let order = await updateOrderStatus(orderStatusMatch[1],payload.status);
                sendJson(response,200,order);
            }catch(error){
                if(error instanceof SyntaxError || error instanceof OrderValidationError){
                    sendJson(response,400,{error:error instanceof SyntaxError ? "Order status data must be valid JSON." : error.message});
                }else if(error.statusCode === 404 || error.statusCode === 409){
                    sendJson(response,error.statusCode,{error:error.message});
                }else{
                    console.error("Could not update cafeteria order status:",error.message);
                    sendJson(response,500,{error:"Could not update order status."});
                }
            }
            return;
        }

        if(pathname === "/api/orders"){
            if(request.method === "GET"){
                let session = requireRole(request,response,null);
                if(!session){return;}
                try{
                    let canteen = requestUrl.searchParams.get("canteen");
                    if(canteen && !orderCanteens.has(canteen)){
                        sendJson(response,400,{error:"Choose a valid canteen."});
                        return;
                    }
                    let orders = await getOrders();
                    if(session.role === "student"){
                        orders = orders.filter(function(order){return normalizeUserId(order.studentId) === normalizeUserId(session.id);});
                    }
                    sendJson(response,200,orders);
                }catch(error){
                    console.error("Could not load cafeteria orders:",error.message);
                    sendJson(response,500,{error:"Could not load orders."});
                }
                return;
            }
            if(request.method !== "POST"){
                response.setHeader("Allow","GET, POST, OPTIONS");
                sendJson(response,405,{error:"Method not allowed."});
                return;
            }
            let session = requireRole(request,response,"student");
            if(!session){return;}
            try{
                let payload = JSON.parse(await readBody(request));
                let result;
                if(payload && payload.paymentMode === "rfid"){
                    result = await createRfidPendingOrder(payload,session);
                }else if(!payload || payload.paymentMode === undefined || payload.paymentMode === "wallet"){
                    result = await createWalletOrder(payload,session);
                }else{
                    throw new OrderValidationError("Choose a supported payment method.");
                }
                sendJson(response,201,{...result.order,balance:result.balance});
            }catch(error){
                if(error instanceof SyntaxError){
                    sendJson(response,400,{error:"Order data must be valid JSON."});
                }else if(error instanceof OrderValidationError){
                    sendJson(response,400,{error:error.message});
                }else if(error.statusCode === 402 || error.statusCode === 401 || error.statusCode === 409){
                    sendJson(response,error.statusCode,{error:error.message,balance:error.balance,required:error.required});
                }else{
                    console.error("Could not save cafeteria order:",error.message);
                    sendJson(response,500,{error:"Could not save order. Please try again."});
                }
            }
            return;
        }

        if(pathname === "/api/tests"){
            let data = await getData();
            if(request.method === "GET"){sendJson(response,200,data.tests);return;}
            if(request.method === "POST"){
                try{data.tests = JSON.parse(await readBody(request));await saveData(data);sendJson(response,200,{saved:true});}
                catch(error){sendJson(response,400,{error:"Invalid tests data."});}
                return;
            }
        }
        if(pathname === "/api/accounts"){
            let data = await getData();
            if(request.method === "GET"){sendJson(response,200,data.accounts);return;}
            if(request.method === "POST"){
                try{data.accounts = JSON.parse(await readBody(request));await saveData(data);sendJson(response,200,{saved:true});}
                catch(error){sendJson(response,400,{error:"Invalid accounts data."});}
                return;
            }
        }
        if(pathname === "/api/generate-test" && request.method === "POST"){
            try{
                let payload = JSON.parse(await readBody(request));
                let text = await extractDocumentText(payload.fileName,Buffer.from(payload.data,"base64"));
                if(!text){sendJson(response,400,{error:"No readable text was found in the document."});return;}
                let generated = await generateQuestions(text,payload.title || payload.fileName);
                sendJson(response,200,{title:payload.title || path.basename(payload.fileName,path.extname(payload.fileName)),subject:payload.subject || "General",questions:generated.questions,mode:generated.mode,message:generated.message,sourceText:text.slice(0,500)});
            }catch(error){sendJson(response,400,{error:error.message || "Could not convert the document."});}
            return;
        }

        if(request.method === "GET" && (pathname === "/" || pathname === "/index.html")){
            serveIndex(response);
            return;
        }

        if(request.method === "GET" && pathname.endsWith(".html")){
            const safePath = pathname.slice(1);
            if(safePath.includes("..")){
                sendJson(response,400,{error:"Invalid file path."});
                return;
            }
            const requestedFile = path.join(root, safePath);
            if(!requestedFile.startsWith(root + path.sep) && requestedFile !== root){
                sendJson(response,400,{error:"Invalid file path."});
                return;
            }
            fs.readFile(requestedFile,function(error,content){
                if(error){sendJson(response,404,{error:"File not found."});return;}
                response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
                response.end(content);
            });
            return;
        }

        sendJson(response,404,{error:"Not found"});
}

    initializeDatabase().then(ensureBootstrapStaff).then(function(){
    let certificatePath = process.env.TLS_CERT_FILE;
    let privateKeyPath = process.env.TLS_KEY_FILE;
    if(Boolean(certificatePath) !== Boolean(privateKeyPath)){
        throw new Error("Configure both TLS_CERT_FILE and TLS_KEY_FILE, or leave both unset.");
    }
    let server = certificatePath
        ? https.createServer({cert:fs.readFileSync(certificatePath),key:fs.readFileSync(privateKeyPath)},handleRequest)
        : http.createServer(handleRequest);
    server.listen(port, host, function(){
        let protocol = certificatePath ? "https" : "http";
        console.log("Learning system server running at " + protocol + "://" + host + ":" + port + (database ? " with PostgreSQL storage" : " with local JSON storage"));
        if(!certificatePath && process.env.NODE_ENV !== "production"){
            console.warn("Plain HTTP is active. Use test credentials and balances only until HTTPS is configured.");
        }
    });
    }).catch(function(error){
        console.error("Could not initialize PostgreSQL storage:",error.message);
        process.exit(1);
    });
