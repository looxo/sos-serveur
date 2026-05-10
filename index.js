const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } = require('discord.js');

const TOKEN   = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.MessageContent,
  ]
});

// ── Enregistre la commande /diagnostic ───────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('diagnostic')
    .setDescription('Analyse complète du serveur Discord')
    .toJSON()
];

client.once('ready', async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Commande /diagnostic enregistrée');
  } catch(e) {
    console.error('Erreur commande:', e);
  }
});

// ── Commande /diagnostic ─────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'diagnostic') return;

  await interaction.deferReply();

  const guild = interaction.guild;
  await guild.members.fetch();
  await guild.channels.fetch();
  await guild.roles.fetch();

  // ── Analyse membres ───────────────────────────────────
  const members      = guild.members.cache;
  const totalMembers = members.size;
  const bots         = members.filter(m => m.user.bot).size;
  const humains      = totalMembers - bots;
  const enligne      = members.filter(m => m.presence?.status === 'online' || m.presence?.status === 'idle' || m.presence?.status === 'dnd').size;
  const sansPseudo   = members.filter(m => !m.nickname && !m.user.bot).size;

  // ── Analyse salons ────────────────────────────────────
  const channels     = guild.channels.cache;
  const texte        = channels.filter(c => c.type === 0).size;
  const vocal        = channels.filter(c => c.type === 2).size;
  const categories   = channels.filter(c => c.type === 4).size;
  const annonce      = channels.filter(c => c.type === 5).size;
  const forum        = channels.filter(c => c.type === 15).size;
  const sansCateg    = channels.filter(c => c.type === 0 && !c.parentId).size;

  // ── Analyse rôles ─────────────────────────────────────
  const roles        = guild.roles.cache;
  const totalRoles   = roles.size - 1; // exclut @everyone
  const rolesAdmin   = roles.filter(r => r.permissions.has('Administrator')).size;
  const rolesSansMembre = roles.filter(r => r.members.size === 0 && !r.managed && r.id !== guild.id).size;

  // ── Analyse bots ──────────────────────────────────────
  const botsListe    = members.filter(m => m.user.bot).map(m => m.user.username).join(', ') || 'Aucun';

  // ── Score & problèmes ─────────────────────────────────
  let score = 100;
  const problemes = [];
  const solutions = [];
  const positifs  = [];

  // Vérifications
  if (humains < 10) { score -= 10; problemes.push('Peu de membres humains'); solutions.push('Fais de la promotion du serveur'); }
  else positifs.push(`${humains} membres humains`);

  if (bots > humains * 0.3) { score -= 10; problemes.push('Trop de bots par rapport aux membres'); solutions.push('Supprime les bots inutilisés'); }
  else positifs.push('Ratio bots/membres équilibré');

  if (rolesAdmin > 3) { score -= 15; problemes.push(`${rolesAdmin} rôles avec permission Administrateur`); solutions.push('Limite les permissions admin à 2-3 rôles max'); }
  else positifs.push('Permissions administrateur bien gérées');

  if (rolesSansMembre > 5) { score -= 10; problemes.push(`${rolesSansMembre} rôles vides sans membres`); solutions.push('Supprime ou réorganise les rôles inutilisés'); }

  if (sansCateg > 3) { score -= 5; problemes.push(`${sansCateg} salons sans catégorie`); solutions.push('Organise tes salons dans des catégories'); }
  else positifs.push('Salons bien organisés en catégories');

  if (texte > 30) { score -= 5; problemes.push(`${texte} salons texte — peut être trop`); solutions.push('Regroupe certains salons ou utilise des fils'); }
  else positifs.push(`${texte} salons texte — nombre raisonnable`);

  if (enligne === 0) { score -= 5; problemes.push('Aucun membre en ligne détecté'); solutions.push('Vérifie que le Presence Intent est activé'); }

  if (annonce === 0) { score -= 5; problemes.push('Pas de salon d\'annonces'); solutions.push('Crée un salon #annonces pour informer les membres'); }
  else positifs.push('Salon d\'annonces présent');

  score = Math.max(0, Math.min(100, score));

  // ── Couleur selon score ───────────────────────────────
  const couleur = score >= 80 ? 0x22c55e : score >= 50 ? 0xf97316 : 0xef4444;
  const emoji   = score >= 80 ? '🟢' : score >= 50 ? '🟠' : '🔴';

  // ── Embed principal ───────────────────────────────────
  const embed = new EmbedBuilder()
    .setTitle(`🔍 Diagnostic — ${guild.name}`)
    .setColor(couleur)
    .setThumbnail(guild.iconURL())
    .addFields(
      { name: '📊 Note du serveur', value: `**${emoji} ${score}/100**`, inline: false },
      { name: '👥 Membres', value: `Total: **${totalMembers}** | Humains: **${humains}** | Bots: **${bots}** | En ligne: **${enligne}**`, inline: false },
      { name: '💬 Salons', value: `Texte: **${texte}** | Vocal: **${vocal}** | Catégories: **${categories}** | Annonces: **${annonce}** | Forums: **${forum}**`, inline: false },
      { name: '🎭 Rôles', value: `Total: **${totalRoles}** | Admin: **${rolesAdmin}** | Vides: **${rolesSansMembre}**`, inline: false },
      { name: '🤖 Bots présents', value: botsListe.length > 200 ? botsListe.substring(0,200)+'...' : botsListe, inline: false },
    )
    .setFooter({ text: 'SOS Serveur • Diagnostic automatique' })
    .setTimestamp();

  // ── Embed positifs ────────────────────────────────────
  const embedPos = new EmbedBuilder()
    .setTitle('✅ Points positifs')
    .setColor(0x22c55e)
    .setDescription(positifs.length > 0 ? positifs.map(p => `✅ ${p}`).join('\n') : 'Aucun point positif détecté');

  // ── Embed problèmes ───────────────────────────────────
  const embedProb = new EmbedBuilder()
    .setTitle('⚠️ Problèmes détectés')
    .setColor(0xef4444)
    .setDescription(problemes.length > 0 ? problemes.map(p => `❌ ${p}`).join('\n') : '✅ Aucun problème détecté !');

  // ── Embed solutions ───────────────────────────────────
  const embedSol = new EmbedBuilder()
    .setTitle('💡 Solutions recommandées')
    .setColor(0x3b82f6)
    .setDescription(solutions.length > 0 ? solutions.map((s,i) => `**${i+1}.** ${s}`).join('\n') : '✅ Tout est bon !');

  await interaction.editReply({ embeds: [embed, embedPos, embedProb, embedSol] });
});

client.login(TOKEN);
