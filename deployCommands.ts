import { SlashCommandBuilder, Routes } from 'discord.js';
import { REST } from '@discordjs/rest';

import * as dotenv from 'dotenv';
dotenv.config({ path: __dirname + '/.env' });

const rest = new REST({ version: '10' })
	.setToken(process.env.DISCORD_TOKEN!);

const commands = [

  new SlashCommandBuilder()
    .setName('ping')     
    .setDescription('Replies with pong!'),

  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Buy stocks')
    .addStringOption(option => option
      .setName('ticker')
      .setDescription('Stock ticker')
      .setRequired(true)
    )
    .addIntegerOption(option => option
      .setName('volume')
      .setDescription('Number of stocks to buy')
      .setRequired(false) // Default 1
    ),

  new SlashCommandBuilder()
    .setName('sell')
    .setDescription('Sell stocks')
    .addStringOption(option => option
      .setName('ticker')
      .setDescription('Stock ticker')
      .setRequired(true)
    )
    .addIntegerOption(option => option
      .setName('volume')
      .setDescription('Number of stocks to sell')
      .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('getprice')
    .addStringOption(option => option
      .setName('ticker')
      .setDescription('Stock ticker')
      .setRequired(false)
    )
    .setDescription('View the price of a stock'),

  new SlashCommandBuilder()
    .setName('setticker')
    .addStringOption(option => option
      .setName('ticker')
      .setDescription('Stock ticker or server ID')
      .setRequired(true)
    )
]
  .map(command => command.toJSON());

// Add global commands
rest
	.put(Routes.applicationCommands(process.env.CLIENT_ID!), { body: commands })
	.then(() => console.log('Successfully registered application commands.'))
	.catch(console.error);

/*
// Delete all global commands
rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), { body: [] })
	.then(() => console.log('Successfully deleted all application commands.'))
	.catch(console.error);
*/