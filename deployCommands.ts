/*
frivolousStonks: A virtual stock market for Discord servers.
Copyright (C) 2022 Matthew Epshtein, Weiju Wang.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

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
        .setDescription('Buy stocks. If you don\'t specify a price, stocks will be bought for whatever prices are available')
        .addStringOption(option => option
            .setName('ticker')
            .setDescription('Stock ticker')
            .setRequired(true)
        )
        .addIntegerOption(option => option
            .setName('volume')
            .setDescription('Number of stocks to buy')
            .setRequired(false) // Default 1
        )
        .addIntegerOption(option => option
            .setName('price')
            .setDescription('Price to buy the stock at. Generally slower since you must wait for available stock at your price')
            .setRequired(false)
        ),

    new SlashCommandBuilder()
    .setName('sell')
    .setDescription('Sell stocks. If you don\'t specify a price, your stock will be sold for whatever prices are available')
    .addStringOption(option => option
        .setName('ticker')
        .setDescription('Stock ticker')
        .setRequired(true)
    )
    .addIntegerOption(option => option
        .setName('volume')
        .setDescription('Number of stocks to sell')
        .setRequired(false)
    )
    .addIntegerOption(option => option
        .setName('price')
        .setDescription('Price to sell the stock at. Generally slower since you must wait for available stock at your price')
        .setRequired(false)
    ),

    new SlashCommandBuilder()
        .setName('price')
        .addStringOption(option => option
            .setName('ticker')
            .setDescription('Stock ticker')
            .setRequired(false)
        )
        .setDescription('View the price of a stock.'),

    new SlashCommandBuilder()
        .setName('orderinfo')
        .setDescription('Cancel a buy or sell order.')
        .addStringOption(option => option
            .setName('orderid')
            .setDescription('ID of the order you want to cancel.')
            .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('cancel')
        .setDescription('Cancel a buy or sell order.')
        .addStringOption(option => option
            .setName('orderid')
            .setDescription('ID of the order you want to cancel.')
            .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('graph')
        .addStringOption(option => option
            .setName('ticker')
            .setDescription('Stock ticker')
            .setRequired(false)
        )
        .setDescription('View a graph of a stock\'s price over time.'),

    new SlashCommandBuilder()
        .setName('setticker')
        .addStringOption(option => option
            .setName('ticker')
            .setDescription('Stock ticker or server ID')
            .setRequired(true)
        )
        .setDescription('Set the ticker for this server.'),

    new SlashCommandBuilder()
        .setName('balance')
        .setDescription('View your coin balance.'),

    new SlashCommandBuilder()
        .setName('account')
        .setDescription('View your account.'),

    new SlashCommandBuilder()
        .setName('stoptrading')
        .setDescription('Stop the entire exchange.'),

    new SlashCommandBuilder()
        .setName('conttrading')
        .setDescription('Continue trading.')
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