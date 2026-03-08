const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  Partials,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
  MessageFlags
} = require("discord.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
require("dotenv").config();
const luamin = require("luamin");
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
const cors = require("cors");
app.use(cors({
  origin: "https://oriondevelopmentrblx.com"
}));
// ⭐ IMPORTANT: Let Railway choose the port
const PORT = process.env.PORT || 3000;
const mongoose = require("mongoose");
// lumain ///
function obfuscateLua(luaText) {
  try {
    return luamin.minify(luaText);
  } catch (e) {
    console.error("Luamin error:", e);
    return null;
  }
}

const verifyCodeSchema = new mongoose.Schema({
  code: { type: String, unique: true, required: true },
  robloxUserId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 600 } // 10 min
});
const VerifyCode = mongoose.model("VerifyCode", verifyCodeSchema);

const linkSchema = new mongoose.Schema(
  {
    robloxUserId: { type: String, unique: true, index: true, required: true },
    discordId: { type: String, index: true, required: true }
  },
  { timestamps: true }
);
const Link = mongoose.model("Link", linkSchema);
async function seedAllLinks() {
  const links = {
    "767086310": "1092226514331901974",
    "2010692028": "1144811100123181067",
    "2500387883": "1327985133571276803",
    "7166591497": "1465975271105757267",
    "2690789706": "1180530069941268673",
    "2687108158": "1190692291535446156",
    "1709414759": "1465975271105757267",
    "2646904035": "1337794483185516574"
  };

  const operations = Object.entries(links).map(([robloxUserId, discordId]) => ({
    updateOne: {
      filter: { robloxUserId: String(robloxUserId) },
      update: { $set: { discordId: String(discordId) } },
      upsert: true
    }
  }));

  const result = await Link.bulkWrite(operations, { ordered: false });

  console.log("Seed complete:", {
    upserted: result.upsertedCount,
    modified: result.modifiedCount,
    matched: result.matchedCount
  });
}
// ----------------------------------------------------
// DATA PERSISTENCE (Railway Volume)
// ----------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(fileName, defaultValue) {
  const fullPath = path.join(DATA_DIR, fileName);
  try {
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, JSON.stringify(defaultValue, null, 2));
      return defaultValue;
    }
    const raw = fs.readFileSync(fullPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to load ${fileName}:`, err);
    return defaultValue;
  }
}

function saveJson(fileName, data) {
  const fullPath = path.join(DATA_DIR, fileName);
  try {
    fs.writeFileSync(fullPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to save ${fileName}:`, err);
  }
}



mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("✅ MongoDB Connected");
    await seedAllLinks();
  })
  .catch(err => {
    console.error("Mongo error:", err);
  });
// ----------------------------------------------------
// DOWNTIME STATE (MongoDB)
// ----------------------------------------------------
const downtimeSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: "global" },
    enabled: { type: Boolean, default: false },
    updatedBy: { type: String, default: "" }
  },
  { timestamps: true }
);

const Downtime = mongoose.model("Downtime", downtimeSchema);

async function getDowntimeEnabled() {
  const doc = await Downtime.findOne({ key: "global" }).lean();
  return !!doc?.enabled;
}

async function setDowntimeEnabled(enabled, updatedBy = "") {
const doc = await Downtime.findOneAndUpdate(
  { key: "global" },
  { $set: { enabled: !!enabled, updatedBy } },
  { upsert: true, returnDocument: "after" }
).lean();;

  return !!doc?.enabled;
}

// ----------------------------------------------------
// IN-MEMORY STORES (BACKED BY JSON)
// ----------------------------------------------------
let codeToUserId = loadJson("codes.json", {});          // codeToUserId["123456"] = "2010692028"
let linkedAccounts = loadJson("linked.json", {});       // linkedAccounts["2010692028"] = "1403467428255633428"
let discordToRoblox = {};
for (const [rbxId, dId] of Object.entries(linkedAccounts)) {
  discordToRoblox[String(dId).trim()] = String(rbxId).trim();
}

const productSchema = new mongoose.Schema({
  hub: { type: String, required: true },
  name: String,
  description: String,
  imageId: String,
  devProductId: { type: String, unique: true },
  fileName: String,
  fileDataBase64: String, // ← MUST have comma

  scriptObfuscatedBase64: { type: String, default: "" }
}, { timestamps: true });


const Product = mongoose.model("Product", productSchema);
const ownedSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true }
  },
  { timestamps: true }
);

ownedSchema.index({ userId: 1, productId: 1 }, { unique: true });

const Owned = mongoose.model("Owned", ownedSchema);

// ----------------------------------------------------
// DISCORD BOT SETUP
// ----------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});
          

// OTHER PERSISTED STATE
let warns = loadJson("warns.json", {});                 // warns[userId] = [ { reason, mod }, ... ]
let lastNumberData = loadJson("counting.json", { lastNumber: 0 });
let lastNumber = lastNumberData.lastNumber || 0;

// ----------------------------------------------------
// BASIC STATUS ENDPOINT
// ----------------------------------------------------
const startedAt = Date.now();
const version = process.env.npm_package_version || "unknown";
let lastHeartbeat = Date.now();

// update this wherever your bot pings/loops
setInterval(() => { lastHeartbeat = Date.now(); }, 15000);

app.get("/status", (req, res) => {
  const uptimeSec = (Date.now() - startedAt) / 1000;

  res.json({
    online: true,
    ping: client?.ws?.ping ?? null,
    uptime: uptimeSec,
    lastHeartbeat: lastHeartbeat,
    version: process.env.npm_package_version || "V1.0.0"
  });
});

async function getRobloxUsername(userId) {
  const url = `https://users.roblox.com/v1/users/${userId}`;
  const { data } = await axios.get(url);
  return data?.name || "Unknown";
}

async function getRobloxHeadshotUrl(userId) {
  const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`;
  const { data } = await axios.get(url);

  // data.data is usually an array like [{ imageUrl, state, targetId, ... }]
  return data?.data?.[0]?.imageUrl || null;
}


app.post("/migrate/hub", async (req, res) => {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const result = await Product.updateMany(
    { hub: { $exists: false } },
    { $set: { hub: "Orion" } }
  );

  res.json({ success: true, modified: result.modifiedCount });
});
// ----------------------------------------------------
// ROBLOX → BOT: CREATE CODE
// body: { userId: number, code: "123456" }
// ----------------------------------------------------
app.post("/createCode", async (req, res) => {
  const { userId, code } = req.body;

  if (!userId || !code) {
    return res.json({ success: false, message: "Missing userId or code" });
  }

  try {
    await VerifyCode.findOneAndUpdate(
      { code: String(code) },
      { $set: { robloxUserId: String(userId) }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    console.log(`Saved code ${code} for userId ${userId} in Mongo`);
    return res.json({ success: true });
  } catch (err) {
    console.error("createCode Mongo error:", err);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

// ----------------------------------------------------
// ROBLOX → BOT: CHECK LINKED DISCORD ACCOUNT
// GET /link/:userId
// ----------------------------------------------------
app.get("/link/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId).trim();
    const row = await Link.findOne({ robloxUserId: userId }).lean();

    if (!row?.discordId) return res.json({ linked: false });
    return res.json({ linked: true, discordId: row.discordId });
  } catch (e) {
    console.error("GET /link error:", e);
    return res.status(500).json({ linked: false });
  }
});
// ----------------------------------------------------
// ⭐ ROBLOX ANNOUNCEMENT ENDPOINT
// ----------------------------------------------------
app.post("/announce", async (req, res) => {
  const { title, description } = req.body;

  if (!title || !description) {
    return res.json({ success: false, message: "Missing title or description" });
  }

  try {
    await axios.post(
      `https://apis.roblox.com/messaging-service/v1/universes/${process.env.UNIVERSE_ID}/topics/AnnouncementEvent`,
      {
        message: JSON.stringify({ title, description })
      },
      {
        headers: {
          "x-api-key": process.env.ROBLOX_API_KEY
        }
      }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("Announcement Relay Error:", err.response?.data || err);
    return res.json({ success: false, message: "Relay failed" });
  }
});

// ----------------------------------------------------
// ⭐ PRODUCT API: ADD PRODUCT (from Discord bot)
// body: { name, description, imageId, devProductId, fileName, fileData }
// ----------------------------------------------------
app.post("/addProduct", async (req, res) => {
  const { hub, name, description, imageId, devProductId, fileName, fileData } = req.body;

  if (!hub || !name || !description || !imageId || !devProductId || !fileName || !fileData) {
    return res.json({ success: false, message: "Missing product fields" });
  }

  // Optional: validate hub
function normalizeHub(h) {
  const clean = String(h || "").trim().toLowerCase();

  if (clean === "orion") return "Orion";
  if (clean === "nova lighting") return "Nova Lighting";
  if (clean === "sunlight solutions") return "Sunlight Solutions";

  return null;
}

const fixedHub = normalizeHub(hub);

if (!fixedHub) {
  return res.json({ success: false, message: "Invalid hub" });
}

  try {
    const existing = await Product.findOne({ devProductId: String(devProductId) });
    if (existing) {
      return res.json({ success: false, message: "DevProductId already exists" });
    }

    const product = new Product({
      hub: fixedHub,
      name,
      description,
      imageId,
      devProductId: String(devProductId),
      fileName,
      fileDataBase64: fileData
    });

    await product.save();
    return res.json({ success: true, productId: product._id });
  } catch (err) {
    console.error("AddProduct Error:", err);
    return res.json({ success: false });
  }
});


/// ----------------------------------------------------
// GET downtime state (Roblox can poll)
// ----------------------------------------------------
app.get("/downtime", async (req, res) => {
  try {
    const enabled = await getDowntimeEnabled();
    return res.json({ enabled });
  } catch (e) {
    console.error("GET /downtime error:", e);
    return res.status(500).json({ enabled: false });
  }
});

// ----------------------------------------------------
// SET downtime state (admin only) + broadcast to Roblox
// POST /downtime  body: { enabled: true/false }
// header: x-admin-key: <ADMIN_KEY>
// ----------------------------------------------------
app.post("/downtime", async (req, res) => {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  try {
    const enabled = !!req.body?.enabled;

    const saved = await setDowntimeEnabled(enabled, "api");

    // Broadcast to Roblox live servers (Messaging Service)
    try {
      await axios.post(
        `https://apis.roblox.com/messaging-service/v1/universes/${process.env.UNIVERSE_ID}/topics/DowntimeEvent`,
        { message: JSON.stringify({ enabled: saved }) },
        { headers: { "x-api-key": process.env.ROBLOX_API_KEY } }
      );
    } catch (e) {
      console.error("Downtime broadcast failed:", e.response?.data || e);
    }

    return res.json({ success: true, enabled: saved });
  } catch (e) {
    console.error("POST /downtime error:", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});
// ----------------------------------------------------
// ⭐ PRODUCT API: REMOVE PRODUCT
// body: { productId }
// ----------------------------------------------------
app.post("/removeProduct", async (req, res) => {
  const { productId } = req.body;
  if (!productId) return res.json({ success: false, message: "Missing productId" });

  try {
    const deleted = await Product.findByIdAndDelete(productId);
    if (!deleted) return res.json({ success: false, message: "Invalid productId" });

    await Owned.deleteMany({ productId: new mongoose.Types.ObjectId(productId) });


    console.log("Product removed:", productId);
    return res.json({ success: true });
  } catch (err) {
    console.error("RemoveProduct Error:", err);
    return res.json({ success: false });
  }
});

// ----------------------------------------------------
// ⭐ PRODUCT API: LIST PRODUCTS (for Roblox UI)
// GET /products
// ----------------------------------------------------
app.get("/products", async (req, res) => {
  try {
    const products = await Product.find();

    const list = products.map(p => ({
      id: p._id,
      hub: p.hub, 
      name: p.name,
      description: p.description,
      imageUrl: `https://thumbnails.roblox.com/v1/assets?assetIds=${p.imageId}&size=420x420&format=Png`,
      devProductId: p.devProductId
    }));

    return res.json({ products: list });

  } catch (err) {
    console.error("Fetch Products Error:", err);
    return res.json({ products: [] });
  }
});

// ----------------------------------------------------
// ⭐ PRODUCT API: OWNED PRODUCTS (for Roblox UI)
// GET /owned/:userId
// ----------------------------------------------------
app.get("/owned/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const rows = await Owned.find({ userId }).select("productId");
    return res.json({ owned: rows.map(r => String(r.productId)) });
  } catch (err) {
    console.error("Owned fetch error:", err);
    return res.json({ owned: [] });
  }
});



// ----------------------------------------------------
// ⭐ WHITELIST CHECK (for Roblox Module)
// POST /whitelist/check
// body: { userId, devProductId }
// ----------------------------------------------------
app.post("/whitelist/check", async (req, res) => {
  const { userId, devProductId } = req.body;

  if (!userId || !devProductId) {
    return res.json({ success: false, allowed: false, message: "Missing fields" });
  }

  try {
    // Find the product by devProductId
    const product = await Product.findOne({ devProductId: String(devProductId) });
    if (!product) {
      return res.json({ success: true, allowed: false, message: "Unknown product" });
    }

const ownedRow = await Owned.findOne({
  userId: String(userId),
  productId: product._id
}).select("_id");

const allowed = !!ownedRow;


    return res.json({
      success: true,
      allowed,
      product: allowed
        ? {
            id: String(product._id),
            name: product.name,
            devProductId: product.devProductId
          }
        : null
    });
  } catch (err) {
    console.error("Whitelist check error:", err);
    return res.json({ success: false, allowed: false, message: "Server error" });
  }
});
// ----------------------------------------------------
// WHITELIST CHECK BY PRODUCT ID (matches !profile ownership)
// ----------------------------------------------------

// POST (Roblox/Lua)
// body: { userId, productId }
app.post("/whitelist/checkByProductId", async (req, res) => {
  const { userId, productId } = req.body || {};

  if (!userId || !productId) {
    return res.status(400).json({ success: false, allowed: false, message: "Missing fields" });
  }

  try {
    const ownedRow = await Owned.findOne({
      userId: String(userId),
      productId: new mongoose.Types.ObjectId(String(productId))
    }).select("_id");

    return res.json({ success: true, allowed: !!ownedRow });
  } catch (err) {
    console.error("POST /whitelist/checkByProductId error:", err);
    return res.status(500).json({ success: false, allowed: false, message: "Server error" });
  }
});
// GET (browser test)
// /whitelist/checkByProductId?userId=123&productId=65f...
app.get("/whitelist/checkByProductId", async (req, res) => {
  const { userId, productId } = req.query || {};

  if (!userId || !productId) {
    return res.status(400).json({ success: false, allowed: false, message: "Missing fields" });
  }

  try {
    const ownedRow = await Owned.findOne({
      userId: String(userId),
      productId: new mongoose.Types.ObjectId(String(productId))
    }).select("_id");

    return res.json({ success: true, allowed: !!ownedRow });
  } catch (err) {
    console.error("GET /whitelist/checkByProductId error:", err);
    return res.status(500).json({ success: false, allowed: false, message: "Server error" });
  }

});
// ----------------------------------------------------
// ⭐ PRODUCT API: PURCHASE (from Roblox)
// body: { userId, devProductId }
// CLEANED + FIXED VERSION
// ----------------------------------------------------
app.post("/purchase", async (req, res) => {
  const { userId, devProductId } = req.body;

  if (!userId || !devProductId) {
    return res.json({ success: false, message: "Missing fields" });
  }

  try {
    // 1) Find product
    const product = await Product.findOne({ devProductId: String(devProductId) });
    if (!product) {
      return res.json({ success: false, message: "Unknown product" });
    }

    // 2) Get linked Discord ID
    const row = await Link.findOne({ robloxUserId: String(userId) }).lean();
const discordId = row?.discordId;
    if (!discordId) {
      return res.json({ success: false, message: "User not linked" });
    }

    // 3) Fetch Discord user
    const user = await client.users.fetch(discordId);

    // 4) Save ownership
    await Owned.updateOne(
      { userId: String(userId), productId: product._id },
      { $setOnInsert: { userId: String(userId), productId: product._id } },
      { upsert: true }
    );

    // 5) DM delivery
    const fileBuffer = Buffer.from(product.fileDataBase64, "base64");

    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("🎁 Purchase Delivered")
          .setDescription(product.description)
          .setColor(0x00ffea)
      ],
      files: [
        {
          attachment: fileBuffer,
          name: product.fileName
        }
      ]
    });

    // 6) Product purchase log (channel)
    try {
      const logChannel = await client.channels.fetch(PRODUCT_LOG_CHANNEL).catch(() => null);

      if (logChannel && logChannel.isTextBased()) {
        const logEmbed = new EmbedBuilder()
          .setTitle("Product Purchased")
          .setColor(0x00ffea)
          .addFields(
            { name: "Product", value: product.name || "Unknown", inline: false },
            { name: "Name", value: `<@${user.id}> (\`${user.id}\`)`, inline: false }
          )
          .setThumbnail(user.displayAvatarURL({ size: 256 }))
          .setTimestamp();

        await logChannel.send({ embeds: [logEmbed] });
      }
    } catch (e) {
      console.error("Purchase log error:", e);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Purchase error:", err);
    return res.json({ success: false, message: "Delivery failed" });
  }
});
// ⭐ START WEB SERVER (Railway-compatible)
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

async function migrateLinkedJsonToMongo() {
  try {
    const entries = Object.entries(linkedAccounts || {});
    if (!entries.length) {
      console.log("No linked accounts to migrate.");
      return;
    }

    const bulk = entries.map(([robloxUserId, discordId]) => ({
      updateOne: {
        filter: { robloxUserId: String(robloxUserId).trim() },
        update: { $set: { discordId: String(discordId).trim() } },
        upsert: true
      }
    }));

    const res = await Link.bulkWrite(bulk, { ordered: false });
    console.log("✅ Migrated linked.json → Mongo", {
      upserted: res.upsertedCount,
      modified: res.modifiedCount,
      matched: res.matchedCount
    });
  } catch (err) {
    console.error("❌ Link migration error:", err);
  }
}

// CHANNEL IDS
const MODMAIL_CHANNEL = "1466828764184051944";
const LOG_CHANNEL = "1403467428255633428";
const WELCOME_CHANNEL = "1443713535887806616";
const COUNTING_CHANNEL = "1452063879776436297";
const REVIEW_CHANNEL = "1450909512520175668";
const PRODUCT_LOG_CHANNEL = "1375200039839858738";
// ----------------------------------------------------
// LOG HELPER
// ----------------------------------------------------
async function sendLog(guild, embed) {
  try {
    const channel = guild.channels.cache.get(LOG_CHANNEL);
    if (channel) await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Log Error:", err);
  }
}

client.on("clientReady", () => {
  console.log(`🤖 Bot online as ${client.user.tag}`);
  console.log("Restarted at:", new Date().toLocaleString());
  client.user.setActivity("Monitoring Orion", { type: 3 });

  // ⭐ HEARTBEAT → Sends bot status to Railway every 5 seconds
  setInterval(() => {
    axios.post("https://orionbot-production-b06c.up.railway.app/status", {
      ping: Math.floor(Math.random() * 100),
      uptime: process.uptime(),
      version: "1.0.0"
    }).catch(() => {});
  }, 5000);
});

// ----------------------------------------------------
// WELCOME SYSTEM
// ----------------------------------------------------
client.on("guildMemberAdd", async (member) => {
  const welcomeChannel = member.guild.channels.cache.get(WELCOME_CHANNEL);
  if (welcomeChannel) {
    const embed = new EmbedBuilder()
      .setTitle("👋 Welcome to Orion!")
      .setDescription(`Welcome <@${member.id}> to the server!`)
      .setColor(0x00ffea)
      .setThumbnail(member.user.displayAvatarURL())
      .setTimestamp();

    welcomeChannel.send({ embeds: [embed] });
  }

  sendLog(
    member.guild,
    new EmbedBuilder()
      .setTitle("📥 Member Joined")
      .setDescription(`${member.user.tag} joined the server.`)
      .setColor(0x00ffea)
      .setTimestamp()
  );
});
//// dkdkdkdkdk
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("editproduct:")) return;

  const productId = interaction.customId.split(":")[1];
  const field = interaction.values?.[0];

  const allowedFields = new Set(["name", "description", "imageId", "devProductId", "hub", "file"]);
  if (!allowedFields.has(field)) {
    return interaction.reply({ content: "Invalid selection.", flags: MessageFlags.Ephemeral });
  }

  // Admin only
  const member = interaction.member;
  if (!member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
    return interaction.reply({ content: "No permission.", flags: MessageFlags.Ephemeral });
  }

  // Helper: hub normalize
  function normalizeHub(h) {
    const clean = String(h || "").trim().toLowerCase();
    if (clean === "orion") return "Orion";
    if (clean === "nova lighting") return "Nova Lighting";
    if (clean === "sunlight solutions") return "Sunlight Solutions";
    return null;
  }

  // Prompt
  if (field === "file") {
    await interaction.reply({
      content:
        `Editing **file** for product \`${productId}\`.\n` +
        `Upload the new file in this channel within 60 seconds.\n` +
        `Type \`cancel\` to stop.`,
      flags: MessageFlags.Ephemeral
    });
  } else {
    await interaction.reply({
      content:
        `Editing **${field}** for product \`${productId}\`.\n` +
        `Send the new value in this channel within 60 seconds.\n` +
        `Type \`cancel\` to stop.`,
      flags: MessageFlags.Ephemeral
    });
  }

  // Collect next message from the user
  const filter = (m) => m.author.id === interaction.user.id;
  const collected = await interaction.channel.awaitMessages({
    filter,
    max: 1,
    time: 60000
  }).catch(() => null);

  if (!collected || !collected.size) {
    return interaction.followUp({ content: "Timed out.", flags: MessageFlags.Ephemeral });
  }

  const replyMsg = collected.first();
  const content = (replyMsg.content || "").trim();

  if (content.toLowerCase() === "cancel") {
    return interaction.followUp({ content: "Cancelled.", flags: MessageFlags.Ephemeral });
  }

  try {
    let update = null;

    // FILE FLOW
    if (field === "file") {
      const att = replyMsg.attachments?.first();
      if (!att) {
        return interaction.followUp({
          content: "No attachment found. Upload a file next time.",
          flags: MessageFlags.Ephemeral
        });
      }

      const fileBuffer = await axios
        .get(att.url, { responseType: "arraybuffer" })
        .then((r) => r.data);

      update = {
        fileName: att.name,
        fileDataBase64: Buffer.from(fileBuffer).toString("base64")
      };
    }

    // TEXT FIELDS FLOW
    if (field !== "file") {
      if (!content) {
        return interaction.followUp({ content: "Empty value. Cancelled.", flags: MessageFlags.Ephemeral });
      }

      // Hub validate
      if (field === "hub") {
        const fixed = normalizeHub(content);
        if (!fixed) {
          return interaction.followUp({
            content: "Invalid hub. Use: Orion, Nova Lighting, Sunlight Solutions.",
            flags: MessageFlags.Ephemeral
          });
        }
        update = { hub: fixed };
      } else {
        update = { [field]: content };
      }

      // devProductId must be unique
      if (field === "devProductId") {
        const existing = await Product.findOne({ devProductId: String(content) }).lean();
        if (existing && String(existing._id) !== String(productId)) {
          return interaction.followUp({
            content: "That DevProductId is already used by another product.",
            flags: MessageFlags.Ephemeral
          });
        }
      }
    }

const updated = await Product.findByIdAndUpdate(
  productId,
  { $set: update },
  { returnDocument: "after" }
).lean();

if (!updated) {
  return interaction.followUp({ content: "Product not found.", flags: MessageFlags.Ephemeral });
}

// ⭐ ONLY notify if the FILE was updated
if (field === "file") {

  const owners = await Owned.find({ productId: productId }).lean();

  for (const row of owners) {
    const discordId = linkedAccounts[row.userId];

    const user = await client.users.fetch(discordId).catch(() => null);
    if (!user) continue;

    try {
      await user.send({
        content: "📦 A product you own has been updated. Here is the new file.",
        files: [{
          attachment: Buffer.from(updated.fileDataBase64, "base64"),
          name: updated.fileName
        }]
      });
    } catch {}
  }
}

    // Refresh embed on the original message
    const newEmbed = new EmbedBuilder()
      .setTitle("🛠 Edit Product")
      .setDescription(
        `**Current Product**\n` +
        `• Name: **${updated.name || "Unnamed"}**\n` +
        `• Description: ${updated.description || "None"}\n` +
        `• Hub: **${updated.hub || "None"}**\n` +
        `• ImageId: \`${updated.imageId || "None"}\`\n` +
        `• DevProductId: \`${updated.devProductId || "None"}\`\n` +
        `• File: \`${updated.fileName || "None"}\`\n\n` +
        `Select what you want to change from the dropdown.`
      )
      .setColor(0x00ffea)
      .setFooter({ text: `ProductID: ${productId}` })
      .setTimestamp();

    await interaction.message.edit({ embeds: [newEmbed] }).catch(() => {});

    return interaction.followUp({
      content: `✅ Updated **${field}**.`,
      flags: MessageFlags.Ephemeral
    });
  } catch (err) {
    console.error("editproduct interaction error:", err);
    return interaction.followUp({
      content: "❌ Failed to update. Check logs.",
      flags: MessageFlags.Ephemeral
    });
  }
});
// ----------------------------------------------------
// MODMAIL (DM → STAFF CHANNEL)
// ----------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.guild) return;
  if (message.author.bot) return;

  try {
    const channel = await client.channels.fetch(MODMAIL_CHANNEL);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle("📩 New Modmail Message")
      .setDescription(message.content || "*No content*")
      .addFields({ name: "From", value: `${message.author.tag} (${message.author.id})` })
      .setColor(0x00aaff)
      .setTimestamp();

    channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Modmail Error:", err);
  }
});

// ----------------------------------------------------
// GUILD MESSAGE HANDLER
// ----------------------------------------------------
client.on("messageCreate", async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const args = message.content.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  // ----------------------------------------------------
  // COUNTING SYSTEM
  // ----------------------------------------------------
  if (message.channel.id === COUNTING_CHANNEL) {
    const num = parseInt(message.content);

    if (isNaN(num) || num !== lastNumber + 1) {
      message.delete().catch(() => {});
      return;
    }

    lastNumber = num;
    lastNumberData.lastNumber = lastNumber;
    saveJson("counting.json", lastNumberData);
    return;
  }

  // ----------------------------------------------------
  // AUTO-MOD
  // ----------------------------------------------------
  const badWords = ["fuck", "shit", "bitch"];
  if (badWords.some(w => message.content.toLowerCase().includes(w))) {
    try { await message.delete(); } catch {}

    message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("🛡️ Auto-Moderation")
          .setDescription(`${message.author}, that word is not allowed.`)
          .setColor(0xff0000)
      ]
    });

    return;
  }

// ----------------------------------------------------
// !profile [@user | userId]
// ----------------------------------------------------
if (cmd === "!profile") {
  const raw = (args[1] || "").trim();

  // 1) Resolve target user
  let targetUser = message.mentions.users.first() || null;

  // If no mention, try ID
  if (!targetUser && raw && /^\d{15,20}$/.test(raw)) {
    targetUser = await client.users.fetch(raw).catch(() => null);
  }

  // If nothing provided, default to author
  if (!targetUser) targetUser = message.author;

  const discordId = String(targetUser.id).trim();
const link = await Link.findOne({ discordId }).lean();
const robloxUserId = link?.robloxUserId;

  if (!robloxUserId) {
    return message.reply("Not linked.");
  }

  // Fetch Roblox username + avatar
  let robloxName = "Unknown";
  let headshotUrl = null;

  try {
    robloxName = await getRobloxUsername(robloxUserId);
    headshotUrl = await getRobloxHeadshotUrl(robloxUserId);
  } catch (e) {
    console.error("Profile Roblox fetch error:", e);
  }

  // Owned products
  let ownedIds = [];
  try {
    const ownedRows = await Owned.find({ userId: String(robloxUserId) })
      .select("productId")
      .lean();

    ownedIds = ownedRows.map(r => String(r.productId));
  } catch (e) {
    console.error("Profile owned fetch error:", e);
  }

  // Build product list
  let productLines = [];
  try {
    if (ownedIds.length > 0) {
      const products = await Product.find({ _id: { $in: ownedIds } }).lean();
      const byId = new Map(products.map(p => [String(p._id), p]));

      productLines = ownedIds
        .map(id => byId.get(String(id)))
        .filter(Boolean)
        .map(p => `• **${p.name || "Unnamed"}**`);
    }
  } catch (e) {
    console.error("Profile product fetch error:", e);
  }

  const embed = new EmbedBuilder()
    .setTitle("🧾 Profile")
    .setColor(0x00ffea)
    .addFields(
      { name: "Discord", value: `<@${discordId}> (\`${discordId}\`)`, inline: false },
      { name: "Roblox", value: `**${robloxName}** (\`${robloxUserId}\`)`, inline: false },
      {
        name: "🛒 Here are the products they own",
        value: productLines.length ? productLines.join("\n") : "*No products owned yet.*",
        inline: false
      }
    )
    .setTimestamp();

  if (headshotUrl) embed.setThumbnail(headshotUrl);

  return message.reply({ embeds: [embed] });
}
  // ⭐ !Commands
  if (cmd === "!commands") {
    const embed = new EmbedBuilder()
      .setTitle("📜 OrionBot Commands")
      .setColor(0x00ffea)
      .addFields(
        {
          name: "👥 Public Commands",
          value:
            "`!pverify <code>` – Link Roblox account\n" +
            "`!review <text>` – Submit a review\n" +
            "`!coinflip` – Flip a coin\n" +
            "`!profile [@user]` – View profile and owned products" 
        },
        {
          name: "🛡️ Staff Commands",
          value:
            "`!kick @user`\n" +
            "`!ban @user`\n" +
            "`!warn @user <reason>`\n" +
            "`!admindm @user <message>`\n" +
            "`!embed Title | Description | #Color`\n" +
            "`!giveaway <seconds> <prize>`\n" +
            "`!resetverify <RobloxUserId>`\n" +
            "`!addproduct` – Create a shop product\n" +
            "`!removeproduct` – Remove a shop product\n" +
            "`!downtime` – Puts the game on downtime\n" +
            "`!undowntime` – Removes downtime\n" +
            "`!revoke` – revokes product\n" +
            "`!grant` – grants product\n" +
            "`!whitelist` – Hides the script\n" +
            "`!Hub` – Shows all products and IDs\n" +
            "`!editproduct` – Edits products\n" 
        },
        {
          name: "📢 Roblox Integration",
          value:
            "`!rblxannounce` – Send an announcement to the Roblox game"
        }
      )
      .setFooter({ text: "OrionBot • All systems operational" })
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  }

  // ⭐ !PVerify <6-digit-code>
if (cmd === "!pverify") {
  const code = (args[1] || "").trim();

  if (!/^\d{6}$/.test(code)) {
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Invalid Code")
          .setDescription("Use: `!pverify 123456` (6 digits).")
          .setColor(0xff0000)
      ]
    });
  }

  try {
    // 1) Find code
const row = await VerifyCode.findOneAndDelete({ code }).lean();

if (!row) {
  return message.reply("Invalid or expired code.");
}

    if (!row) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Invalid Code")
            .setDescription("That code is invalid or expired.")
            .setColor(0xff0000)
        ]
      });
    }

    const robloxUserId = String(row.robloxUserId).trim();
    const discordId = String(message.author.id).trim();

    // 2) Save link
    await Link.findOneAndUpdate(
      { robloxUserId },
      { $set: { discordId } },
      { upsert: true }
    );


    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Verified & Linked")
          .setDescription(
            `Linked Roblox user **${robloxUserId}** to Discord user <@${discordId}>.\n` +
            `Roblox can now see your Discord account.`
          )
          .setColor(0x00ff00)
      ]
    });
  } catch (err) {
    console.error("!pverify error:", err);
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Error")
          .setDescription("Verification failed. Try again in a moment.")
          .setColor(0xff0000)
      ]
    });
  }
}

  // ⭐ !Review <text>
  if (cmd === "!review") {
    const reviewText = args.slice(1).join(" ");

    if (!reviewText) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Missing Review")
            .setDescription("Please type your review after the command.")
            .setColor(0xff0000)
        ]
      });
    }

    const reviewChannel = message.guild.channels.cache.get(REVIEW_CHANNEL);
    if (!reviewChannel) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Error")
            .setDescription("Review channel not found.")
            .setColor(0xff0000)
        ]
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("⭐ New Review Submitted")
      .setDescription(reviewText)
      .addFields({ name: "From", value: `${message.author.tag}` })
      .setColor(0x00ffea)
      .setTimestamp()
      .setThumbnail(message.author.displayAvatarURL());

    reviewChannel.send({ embeds: [embed] });

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Review Submitted")
          .setDescription("Thank you for your feedback!")
          .setColor(0x00ff00)
      ]
    });

    return;
  }

  // ⭐ !Coinflip
  if (cmd === "!coinflip") {
    const result = Math.random() < 0.5 ? "Heads" : "Tails";
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🪙 Coinflip")
          .setDescription(result)
          .setColor(0x00ffea)
      ]
    });
  }
  // ⭐ !hub — Show all products grouped by hub
if (cmd === "!hub") {
  try {
    const products = await Product.find().lean();

    if (!products || products.length === 0) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("📦 Orion Product Hub")
            .setDescription("No products found in the database.")
            .setColor(0xff0000)
        ]
      });
    }

    // Group products by hub
    const grouped = {};
    for (const p of products) {
      if (!grouped[p.hub]) grouped[p.hub] = [];
      grouped[p.hub].push(p);
    }

    const embed = new EmbedBuilder()
      .setTitle("📦 Orion Product Hub")
      .setDescription("Here are all products sorted by category.")
      .setColor(0x00ffea)
      .setTimestamp();

    // Add each hub category as a field
    for (const [hubName, items] of Object.entries(grouped)) {
      const lines = items.map(p => `• **${p.name}** — \`${p._id}\``);
      embed.addFields({
        name: `📁 ${hubName}`,
        value: lines.join("\n"),
        inline: false
      });
    }

    return message.reply({ embeds: [embed] });

  } catch (err) {
    console.error("!hub error:", err);
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Error")
          .setDescription("Failed to fetch product list.")
          .setColor(0xff0000)
      ]
    });
  }
}
///////// whiteist cmd///
// ----------------------------------------------------
// !whitelist (Admin only)
// Makes a Lua script that only runs if user owns Product ID in Mongo (Owned)
// ----------------------------------------------------
if (cmd === "!whitelist") {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply("No permission.");
  }

  const dm = await message.author.send(
    "Send the **Product ID** for this script first. Then upload your `.lua` file."
  ).catch(() => null);

  if (!dm) return message.reply("Enable DMs and try again.");

  const productIdMsgCol = await dm.channel.awaitMessages({
    filter: m => m.author.id === message.author.id && !!m.content,
    max: 1,
    time: 120000
  });

  if (!productIdMsgCol.size) {
    return dm.channel.send("Timed out. Run `!whitelist` again.");
  }

  const productId = productIdMsgCol.first().content.trim();

  await dm.channel.send("Now upload your `.lua` file.");

  const fileCol = await dm.channel.awaitMessages({
    filter: m => m.author.id === message.author.id && m.attachments.size > 0,
    max: 1,
    time: 120000
  });

  if (!fileCol.size) {
    return dm.channel.send("Timed out. Run `!whitelist` again.");
  }

  const msg = fileCol.first();
  const att = msg.attachments.first();

  if (!att.name.toLowerCase().endsWith(".lua")) {
    return dm.channel.send("That is not a `.lua` file.");
  }

  if (att.size > 400_000) {
    return dm.channel.send("File too big. Keep it under 400KB.");
  }

  try {
    const dl = await axios.get(att.url, { responseType: "arraybuffer" });
    const luaText = Buffer.from(dl.data).toString("utf8");

    const gate = `
-- Orion Product Whitelist
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local MarketplaceService = game:GetService("MarketplaceService")

local API = "https://orionbot-production-b06c.up.railway.app"
local PRODUCT_ID = "${productId}"
local WEBHOOK = "https://discord.com/api/webhooks/1480107236524298312/TnjT3APbub-8DhlpJs9uk39LZ8phQf206myD-flYKw2VArUW-vOYKwCViiLpUOCUEf7H"

local function getPlayer()
    return Players:GetPlayerFromCharacter(script.Parent)
end

local function safePost(url, payload)
    return pcall(function()
        return HttpService:PostAsync(
            url,
            HttpService:JSONEncode(payload),
            Enum.HttpContentType.ApplicationJson
        )
    end)
end

local function checkOwnership(player)
    local ok, resp = safePost(API .. "/whitelist/checkByProductId", {
        userId = tostring(player.UserId),
        productId = PRODUCT_ID
    })

    if not ok or not resp then
        return false
    end

    local ok2, data = pcall(function()
        return HttpService:JSONDecode(resp)
    end)

    if not ok2 or type(data) ~= "table" then
        return false
    end

    return data.allowed == true
end

local function getGameOwnerInfo()
    local ownerName = "Unknown"
    local ownerId = "Unknown"

    local ok, info = pcall(function()
        return MarketplaceService:GetProductInfo(game.PlaceId)
    end)

    if ok and info then
        if info.Creator then
            ownerName = tostring(info.Creator.Name or "Unknown")
            ownerId = tostring(info.Creator.CreatorTargetId or "Unknown")
        end
    end

    return ownerName, ownerId
end

local function sendWebhook(player)
    local ownerName, ownerId = getGameOwnerInfo()

    local payload = {
        embeds = {
            {
                title = "🚫 Product Blocked",
                description = "A user attempted to load a product they do not own.",
                color = 16711680,
                fields = {
                    {
                        name = "Server Owner",
                        value = player.Name .. " (" .. player.UserId .. ")",
                        inline = false
                    },
                    {
                        name = "Game Owner",
                        value = ownerName .. " (" .. ownerId .. ")",
                        inline = false
                    },
                    {
                        name = "ProductId",
                        value = PRODUCT_ID,
                        inline = true
                    },
                    {
                        name = "Private Server",
                        value = tostring(game.PrivateServerId ~= ""),
                        inline = true
                    },
                    {
                        name = "Game Link",
                        value = "https://www.roblox.com/games/" .. game.PlaceId,
                        inline = false
                    }
                },
                footer = {
                    text = os.date("%d/%m/%Y %H:%M:%S")
                }
            }
        }
    }

    pcall(function()
        HttpService:PostAsync(
            WEBHOOK,
            HttpService:JSONEncode(payload),
            Enum.HttpContentType.ApplicationJson
        )
    end)
end

local player = getPlayer()
if not player then
    return
end

local allowed = checkOwnership(player)

if not allowed then
    warn("Orion: Product blocked for " .. player.Name)
    sendWebhook(player)
    return
end
`;

    const combined = gate + "\\n" + luaText;

    const out = obfuscateLua(combined);
    if (!out) {
      return dm.channel.send("Failed to obfuscate. Bad Lua.");
    }

    const outBuf = Buffer.from(out, "utf8");

    await dm.channel.send({
      content: "Here is your whitelisted + obfuscated script.",
      files: [
        {
          attachment: outBuf,
          name: att.name.replace(/\\.lua$/i, ".obf.lua")
        }
      ]
    });

    return;
  } catch (e) {
    console.error("Whitelist command error:", e);
    return dm.channel.send("Error downloading or processing file.");
  }
}
  // ----------------------------------------------------
  // ADMIN COMMANDS
  // ----------------------------------------------------
async function askForTargetDiscordId(message) {
  // If mention provided
  const mentioned = message.mentions.users.first();
  if (mentioned) return mentioned.id;

  // If ID provided
  const maybeId = (message.content.trim().split(/\s+/)[1] || "").trim();
  if (maybeId && /^\d{15,20}$/.test(maybeId)) return maybeId;

  // Ask in-channel
  const prompt = await message.reply("Send the target user now. Mention them or paste their Discord ID.");

  const collected = await message.channel.awaitMessages({
    filter: m => m.author.id === message.author.id,
    max: 1,
    time: 60000
  });

  if (!collected.size) {
    await prompt.edit("Timed out.");
    return null;
  }

  const m = collected.first();
  const mention2 = m.mentions.users.first();
  if (mention2) return mention2.id;

  const id2 = (m.content || "").trim();
  if (/^\d{15,20}$/.test(id2)) return id2;

  await message.reply("Invalid user. Use a mention or Discord ID.");
  return null;
}

async function pickProductFromDropdown(message, products, title) {
  const list = products.slice(0, 25); // Discord limit per select menu
  const options = list.map(p => ({
    label: (p.name || "Unnamed").slice(0, 100),
    description: (p.hub ? `Hub: ${p.hub}` : "No hub").slice(0, 100),
    value: String(p._id)
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId("product_pick")
    .setPlaceholder("Choose a product")
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(menu);

  const msg = await message.reply({
    embeds: [new EmbedBuilder().setTitle(title).setDescription("Select a product from the dropdown.").setColor(0x00ffea)],
    components: [row]
  });

  const interaction = await msg.awaitMessageComponent({
    componentType: ComponentType.StringSelect,
    time: 60000,
    filter: i => i.user.id === message.author.id
  }).catch(() => null);

  if (!interaction) {
    await msg.edit({ content: "Timed out.", embeds: [], components: [] }).catch(() => {});
    return null;
  }

  const productId = interaction.values?.[0];
  await interaction.deferUpdate().catch(() => {});
  await msg.edit({ components: [] }).catch(() => {});

  return productId || null;
}

// ----------------------------------------
// !grant
// ----------------------------------------
if (cmd === "!grant") {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply("No permission.");
  }

  const targetDiscordId = await askForTargetDiscordId(message);
  if (!targetDiscordId) return;

const linkRow = await Link.findOne({ discordId: String(targetDiscordId).trim() }).lean();
const robloxUserId = linkRow?.robloxUserId;

if (!robloxUserId) return message.reply("User isn’t linked.");

  const products = await Product.find().sort({ createdAt: -1 }).lean();
  if (!products.length) return message.reply("No products found.");

  if (products.length > 25) {
    await message.reply("I can only show 25 products at a time. Showing newest 25.");
  }

  const productId = await pickProductFromDropdown(message, products, "Grant Product");
  if (!productId) return;

try {
  // 1. Save ownership
  await Owned.updateOne(
    { userId: String(robloxUserId), productId: new mongoose.Types.ObjectId(String(productId)) },
    { $setOnInsert: { userId: String(robloxUserId), productId: new mongoose.Types.ObjectId(String(productId)) } },
    { upsert: true }
  );

  // 2. Load full product
  const product = await Product.findById(productId);
  if (!product) return message.reply("❌ Product not found.");

  // 3. Fetch Discord user
  const targetUser = await client.users.fetch(targetDiscordId).catch(() => null);

  // 4. Send DM with file (same as purchase)
  if (targetUser) {
    try {
      const fileBuffer = Buffer.from(product.fileDataBase64, "base64");

      await targetUser.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("🎁 Product Granted")
            .setDescription(product.description || "You have been granted a product.")
            .setColor(0x00ffea)
        ],
        files: [
          {
            attachment: fileBuffer,
            name: product.fileName
          }
        ]
      });
    } catch (e) {
      console.error("Grant DM failed:", e);
      await message.reply("⚠️ Product granted but DM failed.");
    }
  }

  // 5. Log to product log channel (same style as purchase)
  try {
    const logChannel = await client.channels.fetch(PRODUCT_LOG_CHANNEL).catch(() => null);

    if (logChannel && logChannel.isTextBased()) {
      const logEmbed = new EmbedBuilder()
        .setTitle("Product Granted")
        .setColor(0x00ffea)
        .addFields(
          { name: "Product", value: product.name || "Unknown", inline: false },
          { name: "User", value: `<@${targetDiscordId}> (\`${targetDiscordId}\`)`, inline: false },
          { name: "Granted By", value: `${message.author.tag}`, inline: false }
        )
        .setTimestamp();

      await logChannel.send({ embeds: [logEmbed] });
    }
  } catch (e) {
    console.error("Grant log error:", e);
  }

  return message.reply(
    `✅ Granted **${product.name}** to <@${targetDiscordId}> (Roblox: \`${robloxUserId}\`).`
  );

} catch (e) {
  console.error("!grant error:", e);
  return message.reply("❌ Failed to grant product.");
}
}

// ----------------------------------------
// !revoke
// ----------------------------------------
if (cmd === "!revoke") {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply("No permission.");
  }

  const targetDiscordId = await askForTargetDiscordId(message);
  if (!targetDiscordId) return;

const linkRow = await Link.findOne({ discordId: String(targetDiscordId).trim() }).lean();
const robloxUserId = linkRow?.robloxUserId;

if (!robloxUserId) return message.reply("User isn’t linked.");

  // Only show products they actually own (cleaner)
  const ownedRows = await Owned.find({ userId: String(robloxUserId) }).select("productId").lean();
  const ownedIds = ownedRows.map(r => String(r.productId));
  if (!ownedIds.length) return message.reply("That user owns no products.");

  const products = await Product.find({ _id: { $in: ownedIds } }).lean();
  if (!products.length) return message.reply("Could not load owned products.");

  const productId = await pickProductFromDropdown(message, products, "Revoke Product");
  if (!productId) return;

  try {
    await Owned.deleteOne({
      userId: String(robloxUserId),
      productId: new mongoose.Types.ObjectId(String(productId))
    });

    const prod = await Product.findById(productId).lean();
    return message.reply(`✅ Revoked **${prod?.name || "product"}** from <@${targetDiscordId}> (Roblox: \`${robloxUserId}\`).`);
  } catch (e) {
    console.error("!revoke error:", e);
    return message.reply("❌ Failed to revoke product.");
  }
}

// ⭐ !addproduct
if (cmd === "!addproduct") {
  const dm = await message.author.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("🛒 Add New Product")
        .setDescription("I'll ask you for product details. Reply within 60 seconds for each step.")
        .setColor(0x00ffea)
    ]
  }).catch(() => null);

  if (!dm) {
    return message.reply("I couldn't DM you. Please enable DMs and try again.");
  }

const HUBS = ["Orion", "Nova Lighting", "Sunlight Solutions"];

function detectHub(text) {
  const clean = String(text || "").trim().toLowerCase();

  if (clean === "orion") return "Orion";
  if (clean === "nova lighting") return "Nova Lighting";
  if (clean === "sunlight solutions") return "Sunlight Solutions";

  return null;
}

  const ask = async (question) => {
    await dm.channel.send({
      embeds: [new EmbedBuilder().setDescription(question).setColor(0x00ffea)]
    });

    const collected = await dm.channel.awaitMessages({
      filter: m => m.author.id === message.author.id,
      max: 1,
      time: 60000
    });

    if (!collected.size) return null;
    return collected.first();
  };

  // 1) Hub first
const hubMsg = await ask(
  "Type EXACTLY one of these hub names:\n" +
  "`Orion`\n" +
  "`Nova Lighting`\n" +
  "`Sunlight Solutions`"
);
  if (!hubMsg) return dm.channel.send("⏳ Timed out.");

  let hub = detectHub(hubMsg.content);

  let tries = 0;
  while (!hub && tries < 2) {
    tries++;
    const retry = await ask(`I did not catch that. Pick one: ${HUBS.join(", ")}.`);
    if (!retry) return dm.channel.send("⏳ Timed out.");
    hub = detectHub(retry.content);
  }

  if (!hub) return dm.channel.send("❌ Cancelled. Hub not selected.");

  // 2) Product fields
  const nameMsg = await ask("What is the **Product Name**?");
  if (!nameMsg) return dm.channel.send("⏳ Timed out.");
  const productName = nameMsg.content;

  const descMsg = await ask("What is the **Product Description**?");
  if (!descMsg) return dm.channel.send("⏳ Timed out.");
  const productDescription = descMsg.content;

  const imgMsg = await ask("What is the **Product Image ID**? (Roblox asset ID)");
  if (!imgMsg) return dm.channel.send("⏳ Timed out.");
  const imageId = imgMsg.content;

  const devMsg = await ask("What is the **Developer Product ID**?");
  if (!devMsg) return dm.channel.send("⏳ Timed out.");
  const devProductId = devMsg.content;

  // 3) File upload
  await dm.channel.send({
    embeds: [
      new EmbedBuilder()
        .setDescription("Please upload the **file** that buyers will receive.")
        .setColor(0x00ffea)
    ]
  });

  const fileCollected = await dm.channel.awaitMessages({
    filter: m => m.author.id === message.author.id && m.attachments.size > 0,
    max: 1,
    time: 60000
  });

  if (!fileCollected.size) {
    return dm.channel.send("⏳ Timed out. No file received.");
  }

  const file = fileCollected.first().attachments.first();
  const fileBuffer = await axios.get(file.url, { responseType: "arraybuffer" }).then(r => r.data);

  try {
const res = await axios.post(
  "https://orionbot-production-b06c.up.railway.app/addProduct",
  {
    hub: hub,
    name: productName,
    description: productDescription,
    imageId,
    devProductId,
    fileName: file.name,
    fileData: Buffer.from(fileBuffer).toString("base64")
  }
);

if (!res.data?.success) {
  console.error("AddProduct rejected:", res.data);
  return dm.channel.send(
    `❌ Failed: ${res.data?.message || "Unknown error"}`
  );
}

    dm.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Product Added")
          .setDescription(`**${productName}** added to **${hub}**.`)
          .setColor(0x00ff00)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("🛒 Product Added")
        .setDescription(`Product **${productName}** created by ${message.author.tag}.`)
        .setColor(0x00ffea)
        .setTimestamp()
    );
  } catch (err) {
    console.error("AddProduct Error:", err);
    dm.channel.send("❌ Failed to save product. Check server logs.");
  }

  return;
}



// ⭐ !downtime
if (cmd === "!downtime") {
  try {
    const res = await axios.post(
      "https://orionbot-production-b06c.up.railway.app/downtime",
      { enabled: true },
      { headers: { "x-admin-key": process.env.ADMIN_KEY } }
    );

    if (!res.data?.success) {
      console.error("!downtime rejected:", res.data);
      return message.reply("❌ Failed to enable downtime.");
    }

    return message.reply("🛠️ Downtime enabled.");
  } catch (err) {
    console.error("!downtime error:", err.response?.data || err);
    return message.reply("❌ Error enabling downtime. Check Railway logs.");
  }
}

// ⭐ !undowntime
if (cmd === "!undowntime") {
  try {
    const res = await axios.post(
      "https://orionbot-production-b06c.up.railway.app/downtime",
      { enabled: false },
      { headers: { "x-admin-key": process.env.ADMIN_KEY } }
    );

    if (!res.data?.success) {
      console.error("!undowntime rejected:", res.data);
      return message.reply("❌ Failed to disable downtime.");
    }

    return message.reply("✅ Downtime disabled.");
  } catch (err) {
    console.error("!undowntime error:", err.response?.data || err);
    return message.reply("❌ Error disabling downtime. Check Railway logs.");
  }
}

  // ⭐ !removeproduct
if (cmd === "!removeproduct") {
  const dm = await message.author.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("🗑 Remove Product")
        .setDescription("I'll show you the current products. Reply with the **Product ID** to remove.")
        .setColor(0xffaa00)
    ]
  }).catch(() => null);

  if (!dm) {
    return message.reply("I couldn't DM you. Please enable DMs and try again.");
  }

  // Fetch current products from API
  let list = [];
  try {
    const res = await axios.get("https://orionbot-production-b06c.up.railway.app/products");
    list = res.data.products || [];
  } catch (err) {
    console.error("Fetch products error:", err);
    return dm.channel.send("❌ Failed to fetch products.");
  }

  if (list.length === 0) {
    return dm.channel.send("There are currently no products.");
  }

  let desc = list.map(p =>
    `**ID:** ${p.id}\n**Hub:** ${p.hub || "Unknown"}\n**Name:** ${p.name}\n**DevProductId:** ${p.devProductId}`
  ).join("\n\n");

  await dm.channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("Current Products")
        .setDescription(desc)
        .setColor(0x00ffea)
    ]
  });

  const askIdMsg = await dm.channel.awaitMessages({
    filter: m => m.author.id === message.author.id,
    max: 1,
    time: 60000
  });

  if (!askIdMsg.size) {
    return dm.channel.send("⏳ Timed out.");
  }

  const productId = askIdMsg.first().content.trim();

  try {
    const res = await axios.post("https://orionbot-production-b06c.up.railway.app/removeProduct", {
      productId
    });

    if (!res.data.success) {
      return dm.channel.send("❌ Failed to remove product. Check ID.");
    }

    dm.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Product Removed")
          .setDescription(`Product with ID **${productId}** has been removed.`)
          .setColor(0x00ff00)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("🗑 Product Removed")
        .setDescription(`Product ID **${productId}** removed by ${message.author.tag}.`)
        .setColor(0xffaa00)
        .setTimestamp()
    );

  } catch (err) {
    console.error("RemoveProduct Error:", err);
    dm.channel.send("❌ Failed to remove product. Check server logs.");
  }

  return;
}

// ⭐ INTERACTIVE !editproduct
if (cmd === "!editproduct") {

  // Admin check
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply("❌ You do not have permission to use this command.");
  }

  const productId = (args[1] || "").trim();

  // Validate productId format
  if (!productId || !/^[a-f\d]{24}$/i.test(productId)) {
    return message.reply("❌ Usage: `!editproduct <validProductId>`");
  }

  // Fetch product safely
  let product;
  try {
    product = await Product.findById(productId).lean();
  } catch {
    product = null;
  }

  if (!product) {
    return message.reply("❌ Product not found.");
  }

  // Build dropdown
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`editproduct:${productId}`)
    .setPlaceholder("Select what you want to edit")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions([
      { label: "Name", value: "name" },
      { label: "Description", value: "description" },
      { label: "Image ID", value: "imageId" },
      { label: "Dev Product ID", value: "devProductId" },
      { label: "Hub", value: "hub" },
      { label: "File", value: "file" }
    ]);

  const row = new ActionRowBuilder().addComponents(menu);

  // Build embed
  const embed = new EmbedBuilder()
    .setTitle("🛠 Edit Product")
    .setColor(0x00ffea)
    .setDescription(
      `**Current Product**\n` +
      `• Name: **${product.name || "Unnamed"}**\n` +
      `• Description: ${product.description || "None"}\n` +
      `• Hub: **${product.hub || "None"}**\n` +
      `• Image ID: \`${product.imageId || "None"}\`\n` +
      `• Dev Product ID: \`${product.devProductId || "None"}\`\n` +
      `• File: \`${product.fileName || "None"}\`\n\n` +
      `Select what you want to change from the dropdown below.`
    )
    .setFooter({ text: `ProductID: ${productId}` })
    .setTimestamp();

  return message.reply({
    embeds: [embed],
    components: [row]
  });
}
  // ⭐ !ResetVerify <RobloxUserId>
  if (cmd === "!resetverify") {
    const userId = args[1];

    if (!userId || isNaN(userId)) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Invalid UserId")
            .setDescription("Please provide a valid Roblox UserId.")
            .setColor(0xff0000)
        ]
      });
    }

    delete linkedAccounts[userId];
    for (const code in codeToUserId) {
      if (codeToUserId[code] === String(userId)) {
        delete codeToUserId[code];
      }
    }

    saveJson("linked.json", linkedAccounts);
    saveJson("codes.json", codeToUserId);

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("♻️ Verification Reset")
          .setDescription(`Verification/link reset for Roblox user **${userId}**.`)
          .setColor(0x00ff00)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("♻️ Verification Reset Logged")
        .setDescription(
          `Verification/link reset for Roblox user **${userId}** by ${message.author.tag}.`
        )
        .setColor(0x00ff00)
        .setTimestamp()
    );

    return;
  }

  // ⭐ !Kick
  if (cmd === "!kick") {
    const member = message.mentions.members.first();
    if (!member) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Error")
            .setDescription("Mention someone to kick.")
            .setColor(0xff0000)
        ]
      });
    }

    await member.kick();

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("👢 Kicked")
          .setDescription(`Kicked ${member.user.tag}`)
          .setColor(0xffaa00)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("👢 Kick Logged")
        .setDescription(`${member.user.tag} was kicked by ${message.author.tag}`)
        .setColor(0xffaa00)
        .setTimestamp()
    );

    return;
  }

  // ⭐ !Ban
  if (cmd === "!ban") {
    const member = message.mentions.members.first();
    if (!member) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Error")
            .setDescription("Mention someone to ban.")
            .setColor(0xff0000)
        ]
      });
    }

    await member.ban();

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔨 Banned")
          .setDescription(`Banned ${member.user.tag}`)
          .setColor(0xff0000)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("🔨 Ban Logged")
        .setDescription(`${member.user.tag} was banned by ${message.author.tag}`)
        .setColor(0xff0000)
        .setTimestamp()
    );

    return;
  }

  // ⭐ !Warn
  if (cmd === "!warn") {
    const member = message.mentions.members.first();
    const reason = args.slice(2).join(" ") || "No reason";

    if (!member) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Error")
            .setDescription("Mention someone to warn.")
            .setColor(0xff0000)
        ]
      });
    }

    if (!warns[member.id]) warns[member.id] = [];
    warns[member.id].push({ reason, mod: message.author.id });
    saveJson("warns.json", warns);

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚠️ Warned")
          .setDescription(`Warned ${member.user.tag}\n**Reason:** ${reason}`)
          .setColor(0xffcc00)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("⚠️ Warning Logged")
        .setDescription(
          `${member.user.tag} was warned by ${message.author.tag}\n**Reason:** ${reason}`
        )
        .setColor(0xffcc00)
        .setTimestamp()
    );

    return;
  }

  // ⭐ !AdminDM
  if (cmd === "!admindm") {
    const member = message.mentions.members.first();
    const msg = args.slice(2).join(" ");

    if (!member || !msg) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Error")
            .setDescription("Usage: !admindm @user <message>")
            .setColor(0xff0000)
        ]
      });
    }

    member.send(msg).catch(() => {});

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("📨 Sent")
          .setDescription(`Message sent to ${member.user.tag}`)
          .setColor(0x00ffea)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("📨 Admin DM Sent")
        .setDescription(
          `**To:** ${member.user.tag}\n**From:** ${message.author.tag}\n**Message:** ${msg}`
        )
        .setColor(0x00ffea)
        .setTimestamp()
    );

    return;
  }

  // ⭐ !Embed
  if (cmd === "!embed") {
    const content = args.slice(1).join(" ");
    if (!content.includes("|")) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Invalid Format")
            .setDescription("Use: `!embed Title | Description | #Color`")
            .setColor(0xff0000)
        ]
      });
    }

    const [title, description, color] = content.split("|").map(x => x.trim());

    const embed = new EmbedBuilder()
      .setTitle(title || " ")
      .setDescription(description || " ")
      .setColor(color || "#00ffea")
      .setTimestamp();

    message.delete().catch(() => {});
    message.channel.send({ embeds: [embed] });

    return;
  }

  // ⭐ !Giveaway
  if (cmd === "!giveaway") {
    const duration = parseInt(args[1]);
    const prize = args.slice(2).join(" ");

    if (!duration || !prize) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Error")
            .setDescription("Usage: !giveaway <seconds> <prize>")
            .setColor(0xff0000)
        ]
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("🎉 Giveaway!")
      .setDescription(`Prize: **${prize}**\nReact with 🎉 to enter!`)
      .setColor(0x00ffea);

    const msg = await message.channel.send({ embeds: [embed] });
    await msg.react("🎉");

    setTimeout(async () => {
      try {
        const reaction = msg.reactions.cache.get("🎉");
        if (!reaction) return message.channel.send("No reactions found.");

        const users = await reaction.users.fetch();
        const entries = users.filter(u => !u.bot);

        if (entries.size === 0) {
          return message.channel.send("No valid entries.");
        }

        const winner = entries.random();
        message.channel.send(`🎉 Winner: **${winner.tag}**`);

        sendLog(
          message.guild,
          new EmbedBuilder()
            .setTitle("🎉 Giveaway Logged")
            .setDescription(`Prize: **${prize}**\nWinner: **${winner.tag}**`)
            .setColor(0x00ffea)
            .setTimestamp()
        );
      } catch (err) {
        console.error("Giveaway Error:", err);
      }
    }, duration * 1000);

    return;
  }

  // ⭐ !RblxAnnounce
  if (cmd === "!rblxannounce") {
    const content = args.slice(1).join(" ");
    if (!content.includes("|")) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Invalid Format")
            .setDescription("Use: `!rblxannounce Title | Description`")
            .setColor(0xff0000)
        ]
      });
    }

    const [title, description] = content.split("|").map(x => x.trim());

    try {
      await axios.post("https://orionbot-production-b06c.up.railway.app/announce", {
        title,
        description
      });

      message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("📢 Announcement Sent")
            .setDescription("Your announcement has been relayed to Roblox.")
            .setColor(0x00ffea)
        ]
      });

      sendLog(
        message.guild,
        new EmbedBuilder()
          .setTitle("📢 Roblox Announcement Sent")
          .setDescription(`**${title}**\n${description}`)
          .setColor(0x00ffea)
          .setTimestamp()
      );

    } catch (err) {
      console.error("Announcement Error:", err);
      message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Failed")
            .setDescription("Could not send announcement.")
            .setColor(0xff0000)
        ]
      });
    }

    return;
  }
});

// ----------------------------------------------------
// LOGIN BOT
// ----------------------------------------------------
client.login(process.env.DISCORD_TOKEN);
