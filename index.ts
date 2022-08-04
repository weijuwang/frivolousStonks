import * as Discord from 'discord.js';

import * as dotenv from 'dotenv';
dotenv.config({ path: __dirname + '/.env' });

const client: Discord.Client = new Discord.Client({
  intents: [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMembers,
    Discord.GatewayIntentBits.GuildMessages,
    Discord.GatewayIntentBits.MessageContent
  ]
});

client.on('ready', async () => {
  console.log(`Add with https://discord.com/api/oauth2/authorize?client_id=${client!.user!.id}&permissions=2147485697&scope=bot`);
});

client.on('interactionCreate', async (interaction: Discord.Interaction) => {

  if(!interaction.isChatInputCommand())
    return;

  switch(interaction.commandName){

    case 'ping':
      await interaction.reply('pong');
      break;

    default:
      await interaction.reply(`Unrecognized command ${interaction.commandName}`);
        break;
  }
});

client.on('messageCreate', async (message: Discord.Message) => {

  // Do not respond to bots
  if(message.author.bot)
    return;

});

client.login(process.env.DISCORD_TOKEN);