import { SlashCommandBuilder, Routes } from 'discord.js';
import { REST } from '@discordjs/rest';

import * as dotenv from 'dotenv';
dotenv.config({ path: __dirname + '/.env' });

const rest = new REST({ version: '10' })
	.setToken(process.env.DISCORD_TOKEN!);

const commands = [
	new SlashCommandBuilder().setName('ping').setDescription('Replies with pong!'),
	new SlashCommandBuilder().setName('getPrice').addStringOption(option => option.setName('name').setDescription('Name of stock')).setDescription('replies with price of given stock')
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