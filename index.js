// OrionBot - rebuilt and syntax-clean version
// Required packages: discord.js, axios, express, cors, dotenv, mongoose, luamin
// Node.js 18+ recommended.

"use strict";

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  Partials,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
  ActivityType
} = require("discord.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const luamin = require("luamin");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(cors({ origin: "https://oriondevelopmentrblx.com" }));

const PORT = Number(process.env.PORT) || 3000;
const API_BASE = (process.env.API_BASE_URL || "https://orionbott-production.up.railway.app").replace(/\/$/, "");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(fileName, fallback) {
  const file = path.join(DATA_DIR, fileName);
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Could not load ${fileName}:`, error);
    return fallback;
  }
}

function saveJson(fileName, value) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, fileName), JSON.stringify(value, null, 2));
  } catch (error) {
    console.error(`Could not save ${fileName}:`, error);
  }
}

function normalizeHub(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (clean === "orion") return "Orion";
  if (clean === "nova lighting") return "Nova Lighting";
  if (clean === "sunlight solutions") return "Sunlight Solutions";
  return null;
}

function obfuscateLua(source) {
  try {
    return luamin.minify(source);
  } catch (error) {
    console.error("Luamin error:", error);
    return null;
  }
}

const CHANNELS = {
  modmail: "1466828764184051944",
  log: "1403467428255633428",
  welcome: "1443713535887806616",
  counting: "1452063879776436297",
  review: "1450909512520175668",
  productLog: "1375200039839858738"
};

const linkedAccounts = loadJson("linked.json", {});
const codeToUserId = loadJson("codes.json", {});
let warns = loadJson("warns.json", {});
const countingData = loadJson("counting.json", { lastNumber: 0 });
let lastNumber = Number(countingData.lastNumber) || 0;

const whitelistSchema = new mongoose.Schema({
  robloxUserId: { type: String, unique: true, index: true, required: true }
});
const Whitelist = mongoose.model("Whitelist", whitelistSchema);

const verifyCodeSchema = new mongoose.Schema({
  code: { type: String, unique: true, required: true },
  robloxUserId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 600 }
});
const VerifyCode = mongoose.model("VerifyCode", verifyCodeSchema);

const linkSchema = new mongoose.Schema({
  robloxUserId: { type: String, unique: true, index: true, required: true },
  discordId: { type: String, index: true, required: true }
}, { timestamps: true });
const Link = mongoose.model("Link", linkSchema);

const downtimeSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: "global" },
  enabled: { type: Boolean, default: false },
  updatedBy: { type: String, default: "" }
}, { timestamps: true });
const Downtime = mongoose.model("Downtime", downtimeSchema);

const productSchema = new mongoose.Schema({
  hub: { type: String, required: true },
  name: { type: String, required: true },
  description: { type: String, default: "" },
  imageId: { type: String, default: "" },
  devProductId: { type: String, unique: true, required: true },
  fileName: { type: String, required: true },
  fileDataBase64: { type: String, required: true },
  scriptObfuscatedBase64: { type: String, default: "" }
}, { timestamps: true });
const Product = mongoose.model("Product", productSchema);

const ownedSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true }
}, { timestamps: true });
ownedSchema.index({ userId: 1, productId: 1 }, { unique: true });
const Owned = mongoose.model("Owned", ownedSchema);

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

const startedAt = Date.now();
let lastHeartbeat = Date.now();
const ADMIN_PERMISSION = PermissionsBitField.Flags.Administrator;

function isAdmin(message) {
  return Boolean(message.member?.permissions?.has(ADMIN_PERMISSION));
}

async function requireAdmin(message) {
  if (isAdmin(message)) return true;
  await message.reply("No permission.").catch(() => {});
  return false;
}

async function sendLog(guild, embed) {
  try {
    const channel = await guild.channels.fetch(CHANNELS.log).catch(() => null);
    if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("Log error:", error);
  }
}

async function getDowntimeEnabled() {
  const row = await Downtime.findOne({ key: "global" }).lean();
  return Boolean(row?.enabled);
}

async function setDowntimeEnabled(enabled, updatedBy = "") {
  const row = await Downtime.findOneAndUpdate(
    { key: "global" },
    { $set: { enabled: Boolean(enabled), updatedBy } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return Boolean(row?.enabled);
}

async function seedAllLinks() {
  const seed = {
    "767086310": "1092226514331901974",
    "2010692028": "1144811100123181067",
    "2500387883": "1327985133571276803",
    "7166591497": "1465975271105757267",
    "2690789706": "1180530069941268673",
    "2687108158": "1190692291535446156",
    "1709414759": "1465975271105757267",
    "2646904035": "1337794483185516574",
    "1589995973": "959800754854576148"
  };
  const ops = Object.entries(seed).map(([robloxUserId, discordId]) => ({
    updateOne: {
      filter: { robloxUserId },
      update: { $setOnInsert: { robloxUserId, discordId } },
      upsert: true
    }
  }));
  await Link.bulkWrite(ops, { ordered: false });
}

async function migrateLinkedJsonToMongo() {
  const entries = Object.entries(linkedAccounts || {});
  if (!entries.length) return;
  const ops = entries.map(([robloxUserId, discordId]) => ({
    updateOne: {
      filter: { robloxUserId: String(robloxUserId).trim() },
      update: { $setOnInsert: { robloxUserId: String(robloxUserId).trim(), discordId: String(discordId).trim() } },
      upsert: true
    }
  }));
  await Link.bulkWrite(ops, { ordered: false });
  console.log(`Migrated ${entries.length} legacy linked accounts if missing.`);
}

async function getRobloxUsername(userId) {
  const { data } = await axios.get(`https://users.roblox.com/v1/users/${encodeURIComponent(userId)}`, { timeout: 10000 });
  return data?.name || "Unknown";
}

async function getRobloxHeadshotUrl(userId) {
  const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(userId)}&size=420x420&format=Png&isCircular=false`;
  const { data } = await axios.get(url, { timeout: 10000 });
  return data?.data?.[0]?.imageUrl || null;
}

async function getLinkedRobloxId(discordId) {
  const row = await Link.findOne({ discordId: String(discordId) }).lean();
  return row?.robloxUserId || null;
}

async function askForTargetDiscordId(message) {
  const mentioned = message.mentions.users.first();
  if (mentioned) return mentioned.id;

  const firstArg = message.content.trim().split(/\s+/)[1] || "";
  if (/^\d{15,20}$/.test(firstArg)) return firstArg;

  const prompt = await message.reply("Send the target user now. Mention them or paste their Discord ID.");
  const collected = await message.channel.awaitMessages({
    filter: m => m.author.id === message.author.id,
    max: 1,
    time: 60000
  }).catch(() => null);

  if (!collected?.size) {
    await prompt.edit("Timed out.").catch(() => {});
    return null;
  }
  const reply = collected.first();
  const mention = reply.mentions.users.first();
  if (mention) return mention.id;
  const id = (reply.content || "").trim();
  if (/^\d{15,20}$/.test(id)) return id;
  await message.reply("Invalid user. Use a mention or Discord ID.");
  return null;
}

async function pickProductFromDropdown(message, products, title) {
  const list = products.slice(0, 25);
  if (!list.length) {
    await message.reply("No products available.");
    return null;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`product_pick:${message.author.id}`)
    .setPlaceholder("Choose a product")
    .addOptions(list.map(p => ({
      label: String(p.name || "Unnamed").slice(0, 100),
      description: String(p.hub ? `Hub: ${p.hub}` : "No hub").slice(0, 100),
      value: String(p._id)
    })));

  const row = new ActionRowBuilder().addComponents(menu);
  const sent = await message.reply({
    embeds: [new EmbedBuilder().setTitle(title).setDescription("Select a product from the dropdown.").setColor(0x00ffea)],
    components: [row]
  });

  const interaction = await sent.awaitMessageComponent({
    componentType: ComponentType.StringSelect,
    time: 60000,
    filter: i => i.user.id === message.author.id && i.customId === `product_pick:${message.author.id}`
  }).catch(() => null);

  if (!interaction) {
    await sent.edit({ content: "Timed out.", embeds: [], components: [] }).catch(() => {});
    return null;
  }

  const selected = interaction.values[0];
  await interaction.deferUpdate().catch(() => {});
  await sent.edit({ components: [] }).catch(() => {});
  return selected;
}

// ---------------- HTTP API ----------------

app.get("/status", (req, res) => {
  res.json({
    online: client.isReady(),
    ping: client.ws?.ping ?? null,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    lastHeartbeat,
    version: process.env.npm_package_version || "1.0.0"
  });
});

app.post("/migrate/hub", async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers["x-admin-key"] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  try {
    const result = await Product.updateMany(
      { $or: [{ hub: { $exists: false } }, { hub: null }, { hub: "" }] },
      { $set: { hub: "Orion" } }
    );
    return res.json({ success: true, modified: result.modifiedCount });
  } catch (error) {
    console.error("Hub migration error:", error);
    return res.status(500).json({ success: false });
  }
});

app.post("/createCode", async (req, res) => {
  const { userId, code } = req.body || {};
  if (!/^\d{1,20}$/.test(String(userId || "")) || !/^\d{6}$/.test(String(code || ""))) {
    return res.status(400).json({ success: false, message: "Invalid userId or six-digit code" });
  }
  try {
    await VerifyCode.findOneAndUpdate(
      { code: String(code) },
      { $set: { robloxUserId: String(userId), createdAt: new Date() } },
      { upsert: true, new: true }
    );
    return res.json({ success: true });
  } catch (error) {
    console.error("createCode error:", error);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.get("/link/:userId", async (req, res) => {
  try {
    const row = await Link.findOne({ robloxUserId: String(req.params.userId).trim() }).lean();
    return res.json(row?.discordId ? { linked: true, discordId: row.discordId } : { linked: false });
  } catch (error) {
    console.error("GET /link error:", error);
    return res.status(500).json({ linked: false });
  }
});

app.get("/join-check/:userId", async (req, res) => {
  try {
    const downtime = await getDowntimeEnabled();
    if (!downtime) return res.json({ allowed: true });
    const row = await Whitelist.findOne({ robloxUserId: String(req.params.userId) }).lean();
    return res.json({ allowed: Boolean(row) });
  } catch (error) {
    console.error("Join check error:", error);
    return res.status(500).json({ allowed: false });
  }
});

app.post("/announce", async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers["x-admin-key"] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const title = String(req.body?.title || "").trim();
  const description = String(req.body?.description || "").trim();
  if (!title || !description) {
    return res.status(400).json({ success: false, message: "Missing title or description" });
  }
  if (!process.env.UNIVERSE_ID || !process.env.ROBLOX_API_KEY) {
    return res.status(500).json({ success: false, message: "Roblox API environment variables are missing" });
  }
  try {
    await axios.post(
      `https://apis.roblox.com/messaging-service/v1/universes/${process.env.UNIVERSE_ID}/topics/AnnouncementEvent`,
      { message: JSON.stringify({ title, description }) },
      { headers: { "x-api-key": process.env.ROBLOX_API_KEY }, timeout: 15000 }
    );
    return res.json({ success: true });
  } catch (error) {
    console.error("Announcement relay error:", error.response?.data || error.message);
    return res.status(502).json({ success: false, message: "Relay failed" });
  }
});

app.post("/addProduct", async (req, res) => {
  const { hub, name, description, imageId, devProductId, fileName, fileData } = req.body || {};
  const fixedHub = normalizeHub(hub);
  if (!fixedHub || !name || !devProductId || !fileName || !fileData) {
    return res.status(400).json({ success: false, message: "Missing or invalid product fields" });
  }
  if (String(fileData).length > 45_000_000) {
    return res.status(413).json({ success: false, message: "File is too large" });
  }
  try {
    const exists = await Product.findOne({ devProductId: String(devProductId) }).lean();
    if (exists) return res.status(409).json({ success: false, message: "DevProductId already exists" });
    const product = await Product.create({
      hub: fixedHub,
      name: String(name).slice(0, 100),
      description: String(description || "").slice(0, 4000),
      imageId: String(imageId || ""),
      devProductId: String(devProductId),
      fileName: String(fileName).slice(0, 200),
      fileDataBase64: String(fileData)
    });
    return res.json({ success: true, productId: product._id });
  } catch (error) {
    console.error("AddProduct error:", error);
    return res.status(500).json({ success: false, message: "Could not save product" });
  }
});

app.get("/downtime", async (req, res) => {
  try {
    return res.json({ enabled: await getDowntimeEnabled() });
  } catch (error) {
    console.error("GET /downtime error:", error);
    return res.status(500).json({ enabled: false });
  }
});

app.post("/downtime", async (req, res) => {
  if (!process.env.ADMIN_KEY || req.headers["x-admin-key"] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  try {
    const saved = await setDowntimeEnabled(req.body?.enabled === true, "api");
    if (process.env.UNIVERSE_ID && process.env.ROBLOX_API_KEY) {
      try {
        await axios.post(
          `https://apis.roblox.com/messaging-service/v1/universes/${process.env.UNIVERSE_ID}/topics/DowntimeEvent`,
          { message: JSON.stringify({ enabled: saved }) },
          { headers: { "x-api-key": process.env.ROBLOX_API_KEY }, timeout: 15000 }
        );
      } catch (error) {
        console.error("Downtime broadcast failed:", error.response?.data || error.message);
      }
    }
    return res.json({ success: true, enabled: saved });
  } catch (error) {
    console.error("POST /downtime error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/removeProduct", async (req, res) => {
  const productId = String(req.body?.productId || "");
  if (!mongoose.isValidObjectId(productId)) {
    return res.status(400).json({ success: false, message: "Invalid productId" });
  }
  try {
    const deleted = await Product.findByIdAndDelete(productId);
    if (!deleted) return res.status(404).json({ success: false, message: "Product not found" });
    await Owned.deleteMany({ productId: deleted._id });
    return res.json({ success: true });
  } catch (error) {
    console.error("RemoveProduct error:", error);
    return res.status(500).json({ success: false });
  }
});

app.get("/products", async (req, res) => {
  try {
    const products = await Product.find().select("hub name description imageId devProductId").lean();
    return res.json({
      products: products.map(p => ({
        id: String(p._id),
        hub: p.hub,
        name: p.name,
        description: p.description,
        imageId: p.imageId,
        devProductId: p.devProductId
      }))
    });
  } catch (error) {
    console.error("Fetch products error:", error);
    return res.status(500).json({ products: [] });
  }
});

app.get("/owned/:userId", async (req, res) => {
  try {
    const rows = await Owned.find({ userId: String(req.params.userId) }).select("productId").lean();
    return res.json({ owned: rows.map(row => String(row.productId)) });
  } catch (error) {
    console.error("Owned fetch error:", error);
    return res.status(500).json({ owned: [] });
  }
});

app.post("/whitelist/check", async (req, res) => {
  const { userId, devProductId } = req.body || {};
  if (!userId || !devProductId) return res.status(400).json({ success: false, allowed: false, message: "Missing fields" });
  try {
    const product = await Product.findOne({ devProductId: String(devProductId) }).lean();
    if (!product) return res.json({ success: true, allowed: false, message: "Unknown product" });
    const owned = await Owned.exists({ userId: String(userId), productId: product._id });
    return res.json({
      success: true,
      allowed: Boolean(owned),
      product: owned ? { id: String(product._id), name: product.name, devProductId: product.devProductId } : null
    });
  } catch (error) {
    console.error("Whitelist check error:", error);
    return res.status(500).json({ success: false, allowed: false, message: "Server error" });
  }
});

async function checkOwnershipByProductId(userId, productId) {
  if (!mongoose.isValidObjectId(String(productId))) return false;
  return Boolean(await Owned.exists({
    userId: String(userId),
    productId: new mongoose.Types.ObjectId(String(productId))
  }));
}

app.post("/whitelist/checkByProductId", async (req, res) => {
  const { userId, productId } = req.body || {};
  if (!userId || !productId) return res.status(400).json({ success: false, allowed: false, message: "Missing fields" });
  try {
    return res.json({ success: true, allowed: await checkOwnershipByProductId(userId, productId) });
  } catch (error) {
    console.error("POST checkByProductId error:", error);
    return res.status(500).json({ success: false, allowed: false, message: "Server error" });
  }
});

app.get("/whitelist/checkByProductId", async (req, res) => {
  const { userId, productId } = req.query || {};
  if (!userId || !productId) return res.status(400).json({ success: false, allowed: false, message: "Missing fields" });
  try {
    return res.json({ success: true, allowed: await checkOwnershipByProductId(userId, productId) });
  } catch (error) {
    console.error("GET checkByProductId error:", error);
    return res.status(500).json({ success: false, allowed: false, message: "Server error" });
  }
});

app.post("/webhook/product-blocked", async (req, res) => {
  const webhook = process.env.PRODUCT_BLOCKED_WEBHOOK;
  if (!webhook) return res.status(503).json({ success: false, message: "Webhook is not configured" });
  try {
    const { playerName, playerId, productId, gameId, privateServer } = req.body || {};
    const embed = {
      title: "Product Blocked",
      description: "A user attempted to load a product they do not own.",
      color: 0xff0000,
      fields: [
        { name: "Player", value: `${String(playerName || "Unknown")} (${String(playerId || "Unknown")})` },
        { name: "Product ID", value: String(productId || "Unknown"), inline: true },
        { name: "Private Server", value: String(Boolean(privateServer)), inline: true },
        { name: "Game Link", value: gameId ? `https://www.roblox.com/games/${encodeURIComponent(gameId)}` : "Unknown" }
      ],
      timestamp: new Date().toISOString()
    };
    await axios.post(webhook, { embeds: [embed] }, { timeout: 10000 });
    return res.json({ success: true });
  } catch (error) {
    console.error("Product blocked webhook error:", error.message);
    return res.status(500).json({ success: false });
  }
});

app.post("/purchase", async (req, res) => {
  const { userId, devProductId } = req.body || {};
  if (!userId || !devProductId) return res.status(400).json({ success: false, message: "Missing fields" });
  if (!client.isReady()) return res.status(503).json({ success: false, message: "Discord bot is not ready" });

  try {
    const product = await Product.findOne({ devProductId: String(devProductId) });
    if (!product) return res.status(404).json({ success: false, message: "Unknown product" });

    const link = await Link.findOne({ robloxUserId: String(userId) }).lean();
    if (!link?.discordId) return res.status(404).json({ success: false, message: "User not linked" });

    const discordUser = await client.users.fetch(link.discordId);
    await Owned.updateOne(
      { userId: String(userId), productId: product._id },
      { $setOnInsert: { userId: String(userId), productId: product._id } },
      { upsert: true }
    );

    const fileBuffer = Buffer.from(product.fileDataBase64 || "", "base64");
    try {
      await discordUser.send({
        embeds: [new EmbedBuilder().setTitle("Purchase Delivered").setDescription(product.description || "Your product has been delivered.").setColor(0x00ffea)],
        files: [{ attachment: fileBuffer, name: product.fileName || "product.txt" }]
      });
    } catch (dmError) {
      console.error("Purchase DM failed:", dmError);
      return res.status(200).json({ success: true, owned: true, delivered: false, message: "Ownership saved but Discord DM failed" });
    }

    try {
      const logChannel = await client.channels.fetch(CHANNELS.productLog).catch(() => null);
      if (logChannel?.isTextBased()) {
        await logChannel.send({
          embeds: [new EmbedBuilder()
            .setTitle("Product Purchased")
            .setColor(0x00ffea)
            .addFields(
              { name: "Product", value: product.name || "Unknown" },
              { name: "Discord User", value: `<@${discordUser.id}> (${discordUser.id})` },
              { name: "Roblox User ID", value: String(userId) }
            )
            .setThumbnail(discordUser.displayAvatarURL({ size: 256 }))
            .setTimestamp()]
        });
      }
    } catch (error) {
      console.error("Purchase log error:", error);
    }
    return res.json({ success: true, delivered: true });
  } catch (error) {
    console.error("Purchase error:", error);
    return res.status(500).json({ success: false, message: "Delivery failed" });
  }
});

// ---------------- Discord events ----------------

client.once("ready", () => {
  console.log(`Bot online as ${client.user.tag}`);
  console.log("Started:", new Date().toISOString());
  client.user.setActivity("Monitoring Orion", { type: ActivityType.Watching });
  lastHeartbeat = Date.now();
});

setInterval(() => {
  lastHeartbeat = Date.now();
}, 15000).unref();

client.on("guildMemberAdd", async member => {
  try {
    const channel = await member.guild.channels.fetch(CHANNELS.welcome).catch(() => null);
    if (channel?.isTextBased()) {
      await channel.send({
        embeds: [new EmbedBuilder()
          .setTitle("Welcome to Orion!")
          .setDescription(`Welcome <@${member.id}> to the server!`)
          .setColor(0x00ffea)
          .setThumbnail(member.user.displayAvatarURL())
          .setTimestamp()]
      });
    }
    await sendLog(member.guild, new EmbedBuilder()
      .setTitle("Member Joined")
      .setDescription(`${member.user.tag} joined the server.`)
      .setColor(0x00ffea)
      .setTimestamp());
  } catch (error) {
    console.error("Welcome handler error:", error);
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isStringSelectMenu()) return;

  // Edit product dropdown
  if (interaction.customId.startsWith("editproduct:")) {
    const productId = interaction.customId.split(":")[1];
    const field = interaction.values?.[0];
    const allowedFields = new Set(["name", "description", "imageId", "devProductId", "hub", "file"]);
    if (!allowedFields.has(field)) {
      return interaction.reply({ content: "Invalid selection.", ephemeral: true });
    }
    if (!interaction.memberPermissions?.has(ADMIN_PERMISSION)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    await interaction.reply({
      content: `Editing **${field}** for product \`${productId}\`. Send the new value in this channel within 60 seconds. For a file, upload the new file. Type \`cancel\` to stop.`,
      ephemeral: true
    });

    const collected = await interaction.channel.awaitMessages({
      filter: m => m.author.id === interaction.user.id,
      max: 1,
      time: 60000
    }).catch(() => null);
    if (!collected?.size) return interaction.followUp({ content: "Timed out.", ephemeral: true });

    const reply = collected.first();
    if ((reply.content || "").trim().toLowerCase() === "cancel") {
      return interaction.followUp({ content: "Cancelled.", ephemeral: true });
    }

    try {
      let update;
      if (field === "file") {
        const attachment = reply.attachments.first();
        if (!attachment) return interaction.followUp({ content: "Please attach a file.", ephemeral: true });
        if (attachment.size > 8_000_000) return interaction.followUp({ content: "File is too large (8 MB maximum).", ephemeral: true });
        const response = await axios.get(attachment.url, { responseType: "arraybuffer", timeout: 15000 });
        update = {
          fileName: attachment.name || "product.txt",
          fileDataBase64: Buffer.from(response.data).toString("base64")
        };
      } else {
        const value = (reply.content || "").trim();
        if (!value) return interaction.followUp({ content: "Value cannot be empty.", ephemeral: true });
        if (field === "hub") {
          const hub = normalizeHub(value);
          if (!hub) return interaction.followUp({ content: "Use Orion, Nova Lighting, or Sunlight Solutions.", ephemeral: true });
          update = { hub };
        } else {
          update = { [field]: value };
        }
        if (field === "devProductId") {
          const duplicate = await Product.findOne({ devProductId: value, _id: { $ne: productId } }).lean();
          if (duplicate) return interaction.followUp({ content: "That DevProductId is already in use.", ephemeral: true });
        }
      }

      const updated = await Product.findByIdAndUpdate(productId, { $set: update }, { new: true }).lean();
      if (!updated) return interaction.followUp({ content: "Product not found.", ephemeral: true });

      if (field === "file") {
        const owners = await Owned.find({ productId: updated._id }).select("userId").lean();
        for (const owner of owners) {
          const link = await Link.findOne({ robloxUserId: String(owner.userId) }).lean();
          if (!link?.discordId) continue;
          const user = await client.users.fetch(link.discordId).catch(() => null);
          if (!user) continue;
          await user.send({
            content: "A product you own has been updated. Here is the new file.",
            files: [{ attachment: Buffer.from(updated.fileDataBase64, "base64"), name: updated.fileName }]
          }).catch(error => console.error(`Updated-file DM failed for ${link.discordId}:`, error.message));
        }
      }

      const embed = new EmbedBuilder()
        .setTitle("Edit Product")
        .setDescription(
          `**Current Product**\n` +
          `• Name: **${updated.name || "Unnamed"}**\n` +
          `• Description: ${updated.description || "None"}\n` +
          `• Hub: **${updated.hub || "None"}**\n` +
          `• Image ID: \`${updated.imageId || "None"}\`\n` +
          `• DevProductId: \`${updated.devProductId || "None"}\`\n` +
          `• File: \`${updated.fileName || "None"}\``
        )
        .setColor(0x00ffea)
        .setFooter({ text: `Product ID: ${productId}` })
        .setTimestamp();
      await interaction.message.edit({ embeds: [embed], components: [] }).catch(() => {});
      return interaction.followUp({ content: `Updated **${field}** successfully.`, ephemeral: true });
    } catch (error) {
      console.error("Edit product interaction error:", error);
      return interaction.followUp({ content: "Failed to update product. Check Railway logs.", ephemeral: true });
    }
  }
});

// DM → modmail
client.on("messageCreate", async message => {
  if (message.guild || message.author.bot) return;
  try {
    const channel = await client.channels.fetch(CHANNELS.modmail).catch(() => null);
    if (!channel?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setTitle("New Modmail Message")
      .setDescription((message.content || "*No content*").slice(0, 4000))
      .addFields({ name: "From", value: `${message.author.tag} (${message.author.id})` })
      .setColor(0x00aaff)
      .setTimestamp();
    if (message.attachments.size) {
      embed.addFields({ name: "Attachments", value: message.attachments.map(a => a.url).join("\n").slice(0, 1000) });
    }
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("Modmail error:", error);
  }
});

// Guild commands
client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  const content = message.content.trim();
  if (!content) return;
  const args = content.split(/\s+/);
  const cmd = args[0].toLowerCase();

  try {
    // Counting channel
    if (message.channel.id === CHANNELS.counting) {
      const number = Number(content);
      if (!Number.isInteger(number) || number !== lastNumber + 1) {
        await message.delete().catch(() => {});
        return;
      }
      lastNumber = number;
      countingData.lastNumber = lastNumber;
      saveJson("counting.json", countingData);
      return;
    }

    if (cmd === "!commands") {
      const embed = new EmbedBuilder()
        .setTitle("OrionBot Commands")
        .setColor(0x00ffea)
        .addFields(
          { name: "Public", value: "`!pverify <code>` – Link Roblox account\n`!review <text>` – Submit a review\n`!coinflip` – Flip a coin\n`!profile [@user]` – View profile and products" },
          { name: "Staff", value: "`!kick @user`\n`!ban @user`\n`!warn @user <reason>`\n`!admindm @user <message>`\n`!embed Title | Description | #Color`\n`!giveaway <seconds> <prize>`\n`!resetverify <RobloxUserId>`\n`!addproduct`\n`!removeproduct`\n`!downtime` / `!undowntime`\n`!grant` / `!revoke`\n`!grantall` / `!revokeall`\n`!whitelist`\n`!hub`\n`!editproduct <ProductID>`" },
          { name: "Roblox", value: "`!rblxannounce Title | Description` – Send an in-game announcement" }
        )
        .setFooter({ text: "OrionBot" })
        .setTimestamp();
      return message.reply({ embeds: [embed] });
    }

    if (cmd === "!coinflip") {
      return message.reply({
        embeds: [new EmbedBuilder().setTitle("Coinflip").setDescription(Math.random() < 0.5 ? "Heads" : "Tails").setColor(0x00ffea)]
      });
    }

    if (cmd === "!review") {
      const reviewText = args.slice(1).join(" ").trim();
      if (!reviewText) return message.reply("Please type your review after `!review`.");
      const channel = await message.guild.channels.fetch(CHANNELS.review).catch(() => null);
      if (!channel?.isTextBased()) return message.reply("Review channel not found.");
      await channel.send({
        embeds: [new EmbedBuilder()
          .setTitle("New Review Submitted")
          .setDescription(reviewText.slice(0, 4000))
          .addFields({ name: "From", value: message.author.tag })
          .setColor(0x00ffea)
          .setThumbnail(message.author.displayAvatarURL())
          .setTimestamp()]
      });
      return message.reply("Thank you! Your review has been submitted.");
    }

    if (cmd === "!pverify") {
      const code = String(args[1] || "").trim();
      if (!/^\d{6}$/.test(code)) return message.reply("Use `!pverify 123456` with your six-digit Roblox code.");
      const row = await VerifyCode.findOneAndDelete({ code }).lean();
      if (!row) return message.reply("Invalid or expired code.");
      const robloxUserId = String(row.robloxUserId);
      await Link.findOneAndUpdate(
        { robloxUserId },
        { $set: { robloxUserId, discordId: message.author.id } },
        { upsert: true, new: true }
      );
      return message.reply({
        embeds: [new EmbedBuilder()
          .setTitle("Verified & Linked")
          .setDescription(`Linked Roblox user \`${robloxUserId}\` to <@${message.author.id}>.`)
          .setColor(0x00ff00)]
      });
    }

    if (cmd === "!profile") {
      let target = message.mentions.users.first() || null;
      const raw = args[1] || "";
      if (!target && /^\d{15,20}$/.test(raw)) target = await client.users.fetch(raw).catch(() => null);
      if (!target) target = message.author;

      const link = await Link.findOne({ discordId: target.id }).lean();
      if (!link?.robloxUserId) return message.reply("That Discord account is not linked.");

      let robloxName = "Unknown";
      let headshot = null;
      try {
        [robloxName, headshot] = await Promise.all([
          getRobloxUsername(link.robloxUserId),
          getRobloxHeadshotUrl(link.robloxUserId)
        ]);
      } catch (error) {
        console.error("Profile Roblox lookup error:", error);
      }

      const ownedRows = await Owned.find({ userId: String(link.robloxUserId) }).select("productId").lean();
      const products = ownedRows.length
        ? await Product.find({ _id: { $in: ownedRows.map(row => row.productId) } }).select("name").lean()
        : [];
      const productLines = products.map(p => `• **${p.name || "Unnamed"}**`);
      const embed = new EmbedBuilder()
        .setTitle("Profile")
        .setColor(0x00ffea)
        .addFields(
          { name: "Discord", value: `<@${target.id}> (\`${target.id}\`)` },
          { name: "Roblox", value: `**${robloxName}** (\`${link.robloxUserId}\`)` },
          { name: "Products Owned", value: productLines.join("\n").slice(0, 1000) || "*No products owned yet.*" }
        )
        .setTimestamp();
      if (headshot) embed.setThumbnail(headshot);
      return message.reply({ embeds: [embed] });
    }

    if (cmd === "!hub") {
      const products = await Product.find().sort({ hub: 1, name: 1 }).lean();
      if (!products.length) return message.reply("No products found.");
      const grouped = {};
      for (const product of products) {
        const hub = product.hub || "Other";
        (grouped[hub] ||= []).push(product);
      }
      const embed = new EmbedBuilder().setTitle("Orion Product Hub").setColor(0x00ffea).setTimestamp();
      for (const [hub, items] of Object.entries(grouped)) {
        const lines = items.map(p => `• **${p.name || "Unnamed"}** — \`${p._id}\``);
        for (let i = 0; i < lines.length; i += 15) {
          embed.addFields({ name: hub, value: lines.slice(i, i + 15).join("\n").slice(0, 1024) });
        }
      }
      return message.reply({ embeds: [embed] });
    }

    if (cmd === "!whitelist") {
      if (!(await requireAdmin(message))) return;
      const dm = await message.author.send("Send the **Product ID** for this script. Then upload your `.lua` file.").catch(() => null);
      if (!dm) return message.reply("I couldn't DM you. Enable DMs and try again.");

      const productIdMessages = await dm.channel.awaitMessages({
        filter: m => m.author.id === message.author.id && Boolean(m.content.trim()),
        max: 1,
        time: 120000
      }).catch(() => null);
      if (!productIdMessages?.size) return dm.channel.send("Timed out. Run `!whitelist` again.");

      const productId = productIdMessages.first().content.trim();
      if (!mongoose.isValidObjectId(productId)) return dm.channel.send("That is not a valid Product ID.");
      const product = await Product.findById(productId).lean();
      if (!product) return dm.channel.send("Product not found in the database.");

      await dm.channel.send("Now upload your `.lua` file (maximum 400 KB).");
      const fileMessages = await dm.channel.awaitMessages({
        filter: m => m.author.id === message.author.id && m.attachments.size > 0,
        max: 1,
        time: 120000
      }).catch(() => null);
      if (!fileMessages?.size) return dm.channel.send("Timed out. Run `!whitelist` again.");

      const attachment = fileMessages.first().attachments.first();
      if (!attachment.name?.toLowerCase().endsWith(".lua")) return dm.channel.send("That is not a `.lua` file.");
      if (attachment.size > 400000) return dm.channel.send("File too big. Keep it under 400 KB.");

      try {
        const response = await axios.get(attachment.url, { responseType: "arraybuffer", timeout: 15000 });
        const luaText = Buffer.from(response.data).toString("utf8");
        const gate = `
-- Orion Secure Whitelist
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local API = "${API_BASE}"
local PRODUCT_ID = "${productId}"
local CHECK_ENDPOINT = API .. "/whitelist/checkByProductId"
local WEBHOOK_ENDPOINT = API .. "/webhook/product-blocked"

local function getPlayer()
    local parent = script.Parent
    while parent do
        local player = Players:GetPlayerFromCharacter(parent)
        if player then return player end
        parent = parent.Parent
    end
    return nil
end

local function safePost(url, data)
    local ok, response = pcall(function()
        return HttpService:PostAsync(
            url,
            HttpService:JSONEncode(data),
            Enum.HttpContentType.ApplicationJson
        )
    end)
    if ok then return response end
    return nil
end

local function checkOwnership(player)
    local response = safePost(CHECK_ENDPOINT, {
        userId = tostring(player.UserId),
        productId = PRODUCT_ID
    })
    if not response then return false end
    local ok, decoded = pcall(function()
        return HttpService:JSONDecode(response)
    end)
    return ok and type(decoded) == "table" and decoded.allowed == true
end

local function sendWebhook(player)
    safePost(WEBHOOK_ENDPOINT, {
        playerName = player.Name,
        playerId = player.UserId,
        productId = PRODUCT_ID,
        gameId = game.PlaceId,
        privateServer = game.PrivateServerId ~= ""
    })
end

local player = getPlayer()
if not player then
    warn("Orion whitelist: player not detected")
    return
end
if not checkOwnership(player) then
    warn("Orion whitelist: access denied for " .. player.Name)
    sendWebhook(player)
    return
end
`;
        const combined = gate + "\n\n" + luaText;
        const obfuscated = obfuscateLua(combined);
        const output = obfuscated || combined;
        await dm.channel.send({
          content: obfuscated ? "Here is your whitelisted and obfuscated script." : "Luamin could not obfuscate this file, so here is the protected script without obfuscation.",
          files: [{ attachment: Buffer.from(output, "utf8"), name: attachment.name.replace(/\.lua$/i, obfuscated ? ".obf.lua" : ".whitelist.lua") }]
        });
      } catch (error) {
        console.error("Whitelist command error:", error);
        await dm.channel.send("Error downloading or processing the Lua file.");
      }
      return;
    }

    if (cmd === "!grantall") {
      if (!(await requireAdmin(message))) return;
      const discordId = await askForTargetDiscordId(message);
      if (!discordId) return;
      const robloxId = await getLinkedRobloxId(discordId);
      if (!robloxId) return message.reply("User isn't linked.");
      const products = await Product.find().lean();
      if (!products.length) return message.reply("No products found.");

      let granted = 0;
      for (const product of products) {
        await Owned.updateOne(
          { userId: String(robloxId), productId: product._id },
          { $setOnInsert: { userId: String(robloxId), productId: product._id } },
          { upsert: true }
        );
        granted++;
      }

      const target = await client.users.fetch(discordId).catch(() => null);
      let dmSent = 0;
      if (target) {
        for (const product of products) {
          try {
            await target.send({
              embeds: [new EmbedBuilder().setTitle("Product Granted").setDescription(product.description || "You have been granted a product.").setColor(0x00ffea)],
              files: [{ attachment: Buffer.from(product.fileDataBase64 || "", "base64"), name: product.fileName || "product.txt" }]
            });
            dmSent++;
          } catch (error) {
            console.error(`Grant-all DM failed for ${product.name}:`, error.message);
          }
        }
      }

      const logChannel = await client.channels.fetch(CHANNELS.productLog).catch(() => null);
      if (logChannel?.isTextBased()) {
        await logChannel.send({
          embeds: [new EmbedBuilder().setTitle("All Products Granted").setColor(0x00ffea)
            .addFields(
              { name: "User", value: `<@${discordId}> (${discordId})` },
              { name: "Total Products", value: String(granted) },
              { name: "Files DM'd", value: String(dmSent) },
              { name: "Granted By", value: message.author.tag }
            ).setTimestamp()]
        });
      }
      return message.reply(`Granted **${granted} products** to <@${discordId}>. Files sent by DM: **${dmSent}**.`);
    }

    if (cmd === "!grant") {
      if (!(await requireAdmin(message))) return;
      const discordId = await askForTargetDiscordId(message);
      if (!discordId) return;
      const robloxId = await getLinkedRobloxId(discordId);
      if (!robloxId) return message.reply("User isn't linked.");
      const products = await Product.find().sort({ createdAt: -1 }).lean();
      if (!products.length) return message.reply("No products found.");
      if (products.length > 25) await message.reply("Showing the newest 25 products.");
      const productId = await pickProductFromDropdown(message, products, "Grant Product");
      if (!productId) return;
      const product = await Product.findById(productId).lean();
      if (!product) return message.reply("Product not found.");

      await Owned.updateOne(
        { userId: String(robloxId), productId: product._id },
        { $setOnInsert: { userId: String(robloxId), productId: product._id } },
        { upsert: true }
      );

      const target = await client.users.fetch(discordId).catch(() => null);
      let dmSent = false;
      if (target) {
        try {
          await target.send({
            embeds: [new EmbedBuilder().setTitle("Product Granted").setDescription(product.description || "You have been granted a product.").setColor(0x00ffea)],
            files: [{ attachment: Buffer.from(product.fileDataBase64 || "", "base64"), name: product.fileName || "product.txt" }]
          });
          dmSent = true;
        } catch (error) {
          console.error("Grant DM failed:", error);
        }
      }
      const logChannel = await client.channels.fetch(CHANNELS.productLog).catch(() => null);
      if (logChannel?.isTextBased()) {
        await logChannel.send({ embeds: [new EmbedBuilder().setTitle("Product Granted").setColor(0x00ffea)
          .addFields(
            { name: "Product", value: product.name || "Unknown" },
            { name: "User", value: `<@${discordId}> (${discordId})` },
            { name: "Granted By", value: message.author.tag }
          ).setTimestamp()] });
      }
      return message.reply(`Granted **${product.name}** to <@${discordId}>. ${dmSent ? "File sent by DM." : "Ownership saved, but the DM could not be sent."}`);
    }

    if (cmd === "!revokeall") {
      if (!(await requireAdmin(message))) return;
      const discordId = await askForTargetDiscordId(message);
      if (!discordId) return;
      const robloxId = await getLinkedRobloxId(discordId);
      if (!robloxId) return message.reply("User isn't linked.");
      const result = await Owned.deleteMany({ userId: String(robloxId) });
      const target = await client.users.fetch(discordId).catch(() => null);
      if (target) {
        await target.send({
          embeds: [new EmbedBuilder().setTitle("Products Removed")
            .setDescription("All of your product access has been removed by an administrator. If you believe this was an error, please open a support ticket.")
            .setColor(0xff0000).setTimestamp()]
        }).catch(() => {});
      }
      const logChannel = await client.channels.fetch(CHANNELS.productLog).catch(() => null);
      if (logChannel?.isTextBased()) {
        await logChannel.send({ embeds: [new EmbedBuilder().setTitle("All Products Revoked").setColor(0xff0000)
          .addFields(
            { name: "User", value: `<@${discordId}> (${discordId})` },
            { name: "Products Removed", value: String(result.deletedCount) },
            { name: "Removed By", value: message.author.tag }
          ).setTimestamp()] });
      }
      return message.reply(`Removed **${result.deletedCount} products** from <@${discordId}>.`);
    }

    if (cmd === "!revoke") {
      if (!(await requireAdmin(message))) return;
      const discordId = await askForTargetDiscordId(message);
      if (!discordId) return;
      const robloxId = await getLinkedRobloxId(discordId);
      if (!robloxId) return message.reply("User isn't linked.");
      const ownedRows = await Owned.find({ userId: String(robloxId) }).select("productId").lean();
      if (!ownedRows.length) return message.reply("That user owns no products.");
      const products = await Product.find({ _id: { $in: ownedRows.map(row => row.productId) } }).lean();
      const productId = await pickProductFromDropdown(message, products, "Revoke Product");
      if (!productId) return;
      await Owned.deleteOne({ userId: String(robloxId), productId: new mongoose.Types.ObjectId(productId) });
      const product = await Product.findById(productId).lean();
      return message.reply(`Revoked **${product?.name || "product"}** from <@${discordId}>.`);
    }

    if (cmd === "!addproduct") {
      if (!(await requireAdmin(message))) return;
      const dm = await message.author.send({
        embeds: [new EmbedBuilder().setTitle("Add New Product").setDescription("I'll ask for each detail. Reply within 60 seconds per step.").setColor(0x00ffea)]
      }).catch(() => null);
      if (!dm) return message.reply("I couldn't DM you. Enable DMs and try again.");

      const ask = async question => {
        await dm.channel.send(question);
        const result = await dm.channel.awaitMessages({
          filter: m => m.author.id === message.author.id,
          max: 1,
          time: 60000
        }).catch(() => null);
        return result?.first() || null;
      };

      const hubMessage = await ask("Type exactly: `Orion`, `Nova Lighting`, or `Sunlight Solutions`.");
      if (!hubMessage) return dm.channel.send("Timed out.");
      const hub = normalizeHub(hubMessage.content);
      if (!hub) return dm.channel.send("Invalid hub. Run `!addproduct` again.");

      const nameMessage = await ask("What is the product name?");
      if (!nameMessage) return dm.channel.send("Timed out.");
      const descriptionMessage = await ask("What is the product description?");
      if (!descriptionMessage) return dm.channel.send("Timed out.");
      const imageMessage = await ask("What is the Roblox image asset ID?");
      if (!imageMessage) return dm.channel.send("Timed out.");
      const devMessage = await ask("What is the Developer Product ID?");
      if (!devMessage) return dm.channel.send("Timed out.");
      if (!/^\d+$/.test(devMessage.content.trim())) return dm.channel.send("Dev Product ID must contain numbers only.");

      await dm.channel.send("Upload the file buyers will receive.");
      const fileMessages = await dm.channel.awaitMessages({
        filter: m => m.author.id === message.author.id && m.attachments.size > 0,
        max: 1,
        time: 60000
      }).catch(() => null);
      if (!fileMessages?.size) return dm.channel.send("Timed out. No file received.");

      const file = fileMessages.first().attachments.first();
      if (file.size > 8_000_000) return dm.channel.send("File is too large (8 MB maximum).");
      try {
        const download = await axios.get(file.url, { responseType: "arraybuffer", timeout: 15000 });
        const response = await axios.post(`${API_BASE}/addProduct`, {
          hub,
          name: nameMessage.content.trim(),
          description: descriptionMessage.content.trim(),
          imageId: imageMessage.content.trim(),
          devProductId: devMessage.content.trim(),
          fileName: file.name || "product.txt",
          fileData: Buffer.from(download.data).toString("base64")
        });
        if (!response.data?.success) return dm.channel.send(`Failed: ${response.data?.message || "Unknown error"}`);
        await dm.channel.send({ embeds: [new EmbedBuilder().setTitle("Product Added").setDescription(`**${nameMessage.content.trim()}** added to **${hub}**.`).setColor(0x00ff00)] });
        await sendLog(message.guild, new EmbedBuilder().setTitle("Product Added").setDescription(`**${nameMessage.content.trim()}** created by ${message.author.tag}.`).setColor(0x00ffea).setTimestamp());
      } catch (error) {
        console.error("Add product command error:", error.response?.data || error);
        await dm.channel.send("Failed to save product. Check Railway logs.");
      }
      return;
    }

    if (cmd === "!removeproduct") {
      if (!(await requireAdmin(message))) return;
      const dm = await message.author.send("I'll show the products. Reply with the Product ID to remove.").catch(() => null);
      if (!dm) return message.reply("I couldn't DM you. Enable DMs and try again.");
      const response = await axios.get(`${API_BASE}/products`, { timeout: 10000 });
      const products = response.data?.products || [];
      if (!products.length) return dm.channel.send("There are currently no products.");
      const description = products.map(p => `**ID:** ${p.id}\n**Hub:** ${p.hub || "Unknown"}\n**Name:** ${p.name || "Unnamed"}\n**DevProductId:** ${p.devProductId}`).join("\n\n");
      for (let i = 0; i < description.length; i += 3900) {
        await dm.channel.send({ embeds: [new EmbedBuilder().setTitle("Current Products").setDescription(description.slice(i, i + 3900)).setColor(0x00ffea)] });
      }
      const collected = await dm.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max: 1, time: 60000 }).catch(() => null);
      if (!collected?.size) return dm.channel.send("Timed out.");
      const productId = collected.first().content.trim();
      const removed = await axios.post(`${API_BASE}/removeProduct`, { productId });
      if (!removed.data?.success) return dm.channel.send(`Could not remove product: ${removed.data?.message || "check the ID"}`);
      await dm.channel.send(`Product \`${productId}\` removed.`);
      await sendLog(message.guild, new EmbedBuilder().setTitle("Product Removed").setDescription(`Product ID \`${productId}\` removed by ${message.author.tag}.`).setColor(0xffaa00).setTimestamp());
      return;
    }

    if (cmd === "!editproduct") {
      if (!(await requireAdmin(message))) return;
      const productId = args[1] || "";
      if (!mongoose.isValidObjectId(productId)) return message.reply("Usage: `!editproduct <validProductId>`");
      const product = await Product.findById(productId).lean();
      if (!product) return message.reply("Product not found.");
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`editproduct:${productId}`)
        .setPlaceholder("Select what you want to edit")
        .addOptions([
          { label: "Name", value: "name" },
          { label: "Description", value: "description" },
          { label: "Image ID", value: "imageId" },
          { label: "Dev Product ID", value: "devProductId" },
          { label: "Hub", value: "hub" },
          { label: "File", value: "file" }
        ]);
      const embed = new EmbedBuilder().setTitle("Edit Product").setColor(0x00ffea)
        .setDescription(
          `**Current Product**\n` +
          `• Name: **${product.name || "Unnamed"}**\n` +
          `• Description: ${product.description || "None"}\n` +
          `• Hub: **${product.hub || "None"}**\n` +
          `• Image ID: \`${product.imageId || "None"}\`\n` +
          `• Dev Product ID: \`${product.devProductId || "None"}\`\n` +
          `• File: \`${product.fileName || "None"}\`\n\nSelect a field below.`
        )
        .setFooter({ text: `Product ID: ${productId}` });
      return message.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
    }

    if (cmd === "!downtime" || cmd === "!undowntime") {
      if (!(await requireAdmin(message))) return;
      const enabled = cmd === "!downtime";
      const response = await axios.post(`${API_BASE}/downtime`, { enabled }, {
        headers: { "x-admin-key": process.env.ADMIN_KEY },
        timeout: 15000
      });
      if (!response.data?.success) return message.reply(`Failed to ${enabled ? "enable" : "disable"} downtime.`);
      return message.reply(enabled ? "Downtime enabled." : "Downtime disabled.");
    }

    if (cmd === "!resetverify") {
      if (!(await requireAdmin(message))) return;
      const robloxId = String(args[1] || "").trim();
      if (!/^\d{1,20}$/.test(robloxId)) return message.reply("Usage: `!resetverify <RobloxUserId>`");
      const deletedLink = await Link.findOneAndDelete({ robloxUserId: robloxId });
      await VerifyCode.deleteMany({ robloxUserId: robloxId });
      delete linkedAccounts[robloxId];
      saveJson("linked.json", linkedAccounts);
      const response = deletedLink ? "Verification/link reset." : "No MongoDB link was found; pending codes were cleared.";
      await sendLog(message.guild, new EmbedBuilder().setTitle("Verification Reset").setDescription(`${response}\nRoblox user: \`${robloxId}\`\nBy: ${message.author.tag}`).setColor(0x00ff00).setTimestamp());
      return message.reply(`${response} Roblox user: \`${robloxId}\`.`);
    }

    if (cmd === "!kick" || cmd === "!ban") {
      if (!(await requireAdmin(message))) return;
      const member = message.mentions.members.first();
      if (!member) return message.reply(`Mention someone to ${cmd === "!kick" ? "kick" : "ban"}.`);
      if (member.id === message.author.id) return message.reply("You cannot moderate yourself.");
      if (!member.manageable) return message.reply("I cannot moderate that member. Check my role position and permissions.");
      if (cmd === "!kick") await member.kick(`Action by ${message.author.tag}`);
      else await member.ban({ reason: `Action by ${message.author.tag}` });
      const action = cmd === "!kick" ? "Kicked" : "Banned";
      await message.reply(`${action} **${member.user.tag}**.`);
      await sendLog(message.guild, new EmbedBuilder().setTitle(`${action} Member`).setDescription(`${member.user.tag} was ${action.toLowerCase()} by ${message.author.tag}.`).setColor(cmd === "!kick" ? 0xffaa00 : 0xff0000).setTimestamp());
      return;
    }

    if (cmd === "!warn") {
      if (!(await requireAdmin(message))) return;
      const member = message.mentions.members.first();
      if (!member) return message.reply("Mention someone to warn.");
      const reason = args.slice(2).join(" ") || "No reason provided";
      (warns[member.id] ||= []).push({ reason, mod: message.author.id, at: new Date().toISOString() });
      saveJson("warns.json", warns);
      await message.reply(`Warned **${member.user.tag}**. Reason: ${reason}`);
      await sendLog(message.guild, new EmbedBuilder().setTitle("Warning Logged").setDescription(`${member.user.tag} was warned by ${message.author.tag}\n**Reason:** ${reason}`).setColor(0xffcc00).setTimestamp());
      return;
    }

    if (cmd === "!admindm") {
      if (!(await requireAdmin(message))) return;
      const member = message.mentions.members.first();
      const text = args.slice(2).join(" ");
      if (!member || !text) return message.reply("Usage: `!admindm @user <message>`");
      try {
        await member.send(text);
        await message.reply(`Message sent to ${member.user.tag}.`);
      } catch {
        await message.reply("Could not DM that user.");
      }
      await sendLog(message.guild, new EmbedBuilder().setTitle("Admin DM Sent").setDescription(`To: ${member.user.tag}\nFrom: ${message.author.tag}\nMessage: ${text}`).setColor(0x00ffea).setTimestamp());
      return;
    }

    if (cmd === "!embed") {
      if (!(await requireAdmin(message))) return;
      const raw = args.slice(1).join(" ");
      const parts = raw.split("|").map(s => s.trim());
      if (parts.length < 2 || !parts[0] || !parts[1]) return message.reply("Use: `!embed Title | Description | #Color`");
      const embed = new EmbedBuilder().setTitle(parts[0].slice(0, 256)).setDescription(parts[1].slice(0, 4000)).setColor(parts[2] || "#00ffea").setTimestamp();
      await message.delete().catch(() => {});
      return message.channel.send({ embeds: [embed] });
    }

    if (cmd === "!giveaway") {
      if (!(await requireAdmin(message))) return;
      const duration = Number(args[1]);
      const prize = args.slice(2).join(" ").trim();
      if (!Number.isInteger(duration) || duration < 1 || duration > 604800 || !prize) {
        return message.reply("Usage: `!giveaway <seconds> <prize>` (1 second to 7 days).");
      }
      const giveaway = await message.channel.send({
        embeds: [new EmbedBuilder().setTitle("Giveaway!").setDescription(`Prize: **${prize}**\nReact with 🎉 to enter!`).setColor(0x00ffea)]
      });
      await giveaway.react("🎉");
      setTimeout(async () => {
        try {
          const reaction = giveaway.reactions.cache.get("🎉");
          if (!reaction) return message.channel.send("Giveaway ended with no entries.");
          const users = await reaction.users.fetch();
          const entries = users.filter(user => !user.bot);
          if (!entries.size) return message.channel.send("Giveaway ended with no valid entries.");
          const winner = entries.random();
          await message.channel.send(`Giveaway winner: **${winner.tag}** — Prize: **${prize}**`);
          await sendLog(message.guild, new EmbedBuilder().setTitle("Giveaway Ended").setDescription(`Prize: **${prize}**\nWinner: **${winner.tag}**`).setColor(0x00ffea).setTimestamp());
        } catch (error) {
          console.error("Giveaway error:", error);
        }
      }, duration * 1000).unref?.();
      return;
    }

    if (cmd === "!rblxannounce") {
      if (!(await requireAdmin(message))) return;
      const raw = args.slice(1).join(" ");
      const separator = raw.indexOf("|");
      if (separator < 1) return message.reply("Use: `!rblxannounce Title | Description`");
      const title = raw.slice(0, separator).trim();
      const description = raw.slice(separator + 1).trim();
      if (!title || !description) return message.reply("Both a title and description are required.");
      const response = await axios.post(`${API_BASE}/announce`, { title, description }, {
        headers: { "x-admin-key": process.env.ADMIN_KEY },
        timeout: 20000
      });
      if (!response.data?.success) return message.reply("Roblox announcement failed. Check Railway logs.");
      await sendLog(message.guild, new EmbedBuilder().setTitle("Roblox Announcement Sent").setDescription(`**${title}**\n${description}`).setColor(0x00ffea).setTimestamp());
      return message.reply("Announcement relayed to Roblox.");
    }
  } catch (error) {
    console.error(`Command ${cmd} failed:`, error.response?.data || error);
    await message.reply("Something went wrong while running that command. Check Railway logs.").catch(() => {});
  }
});

// ---------------- Startup ----------------

async function start() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is missing from Railway variables.");
  if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN is missing from Railway variables.");

  await mongoose.connect(process.env.MONGO_URI);
  console.log("MongoDB connected.");
  await seedAllLinks();
  await migrateLinkedJsonToMongo();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP server listening on ${PORT}`);
  });

  await client.login(process.env.DISCORD_TOKEN);
}

start().catch(error => {
  console.error("Startup failed:", error);
  process.exit(1);
});

process.on("unhandledRejection", error => console.error("Unhandled rejection:", error));
process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});
