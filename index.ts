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

import * as Discord from 'discord.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as schedule from 'node-schedule';
import * as plotlyConstructor from 'plotly';
let moment = require('moment');

// Import environment variables
dotenv.config({ path: __dirname + '/.env' });

let plotly = require('plotly')(process.env.PLOTLY_USERNAME, process.env.PLOTLY_APIKEY);

const client: Discord.Client = new Discord.Client({
  intents: [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMessages,
  ]
});

////////////////////////////////////////////////////////////////////////////////

const DATAFOLDER = 'data/';
const STOCKDATA = DATAFOLDER + 'stockData';
const TICKERS = DATAFOLDER + 'tickers';
const BACKWARDSTICKERS = DATAFOLDER + 'backwardsTickers';

const MAXDATAPOINTS = 24 * 60;
const TRUEPRICEWEIGHT = 0.1; // where 1 = weight equal to the current actual price
const DEFAULTNUMSHARES = 100;
const PUBLICAVAILSHARES = 2/3; // The portion of shares available to the public at any given time

const trueStockPrice = (memberCount: number, numMessages: number, numAuthors: number) =>
  10 * Math.log(memberCount) * (numMessages / numAuthors);

////////////////////////////////////////////////////////////////////////////////

interface GuildStockData {
  truePriceHistory: number[],
  truePrice: number,
  actualPrice: number,
  actualPriceHistoryTimestamps: string[],
  actualPriceHistory: number[],
  numShares: number,
  sharesLeft: number
}

interface GuildTempData {
  authors: string[],
  numMessages: number
}

interface OrderBookQueueEntry {
  userId: string, // user making the order
  guildId: string, // ID of the guild of the stock to be bought/sold
  volume: number
}

////////////////////////////////////////////////////////////////////////////////

function getCurrTimestamp(){
  return moment().format('YYYY-MM-DD HH:mm:ss');
}

function readJSONFile(filename: string){
  return JSON.parse(fs.readFileSync(filename + '.json').toString());
}

function writeJSONFile(filename: string, object: Object){
  fs.writeFileSync(filename + '.json', JSON.stringify(object));
}

function readOrderBook(guildId: string){
  return readJSONFile(DATAFOLDER + 'orderBooks/' + guildId);
}

function writeOrderBook(guildId: string, object: Object){
  writeJSONFile(DATAFOLDER + 'orderBooks/' + guildId, object);
}

function getGuild(tickerOrId: string | null, interaction: Discord.Interaction): Discord.Guild | undefined | null {

  /*
  If a guild is returned, it means there is a guild with this ID or ticker.
  If `undefined` is returned, it means no guild exists with this ID or ticker.
  If `null` is returned, it means this ticker is on record as having existed but the bot can no longer see it.
  */

  // If no ticker was given
  if(tickerOrId === null)
    tickerOrId = interaction.guildId!;

  // Assume `tickerOrId` is a guild ID. Find the guild, if any, that it represents
  let guild = client.guilds.cache.get(tickerOrId);

  // If no guild with the ID in `tickerOrId` was found
  if(guild === undefined){

    // Get the ID that `tickerOrId` represents
    tickerOrId = readJSONFile(TICKERS)[tickerOrId.toUpperCase()];

    if(tickerOrId === undefined)
      return undefined;

    // Find the guild with that ID
    guild = client.guilds.cache.get(tickerOrId!);

    if(guild === undefined)
      return null;
  }

  return guild;
}

function adjustStockPrice(guild: Discord.Guild){

  // Read data
  let stockData: {
    [key: string]: GuildStockData
  } = readJSONFile(STOCKDATA);

  let numMessages = 0;
  let numAuthors = 1; // this must be 1 to avoid divide by zero

  if(guild.id in tempMsgData){
    numAuthors = tempMsgData[guild.id].authors.length;
    numMessages = tempMsgData[guild.id].numMessages;
  }

  let thisServer = stockData[guild.id];

  if(thisServer != null){

    let newData = thisServer.truePriceHistory;

    // Add data from the last hour
    newData.unshift(trueStockPrice(guild.memberCount, numMessages, numAuthors));

    // Remove the oldest data point (from exactly 24 hours ago)
    if(newData.length > MAXDATAPOINTS)
      newData.pop();

    thisServer.truePriceHistory = newData;

    // Compute the average of all data points
    thisServer.truePrice = newData.reduce((a: number, b: number) => a + b) / newData.length;

    // The true price pulls the actual price towards it with a certain weight
    thisServer.actualPrice =
      (thisServer.actualPrice + thisServer.truePrice * TRUEPRICEWEIGHT)
      / (TRUEPRICEWEIGHT + 1);

    thisServer.actualPriceHistory.push(thisServer.actualPrice);
    thisServer.actualPriceHistoryTimestamps.push(getCurrTimestamp());

    stockData[guild.id] = thisServer;

  } else {
    // This is the first time we've collected data from this server
    const firstDataPoint = trueStockPrice(guild.memberCount, numMessages, numAuthors);

    stockData[guild.id] = {
      truePriceHistory: [firstDataPoint],
      truePrice: firstDataPoint,
      actualPrice: firstDataPoint,
      actualPriceHistoryTimestamps: [getCurrTimestamp()],
      actualPriceHistory: [firstDataPoint],
      numShares: DEFAULTNUMSHARES,
      sharesLeft: DEFAULTNUMSHARES
    };
  }

  // Write data back to the file
  writeJSONFile(STOCKDATA, stockData);
}

let tempMsgData: {
  [key: string]: GuildTempData
} = {};

////////////////////////////////////////////////////////////////////////////////

client.on('ready', () => {
  console.log(`Add with https://discord.com/api/oauth2/authorize?client_id=${client!.user!.id}&permissions=2147485697&scope=bot`);
});

client.on('interactionCreate', async (interaction: Discord.Interaction) => {

  if(!interaction.isChatInputCommand())
    return;

  switch(interaction.commandName){

    case 'ping': {
      await interaction.reply('pong');
      break;
    }

    case 'getprice': {

      if(interaction.guild === null){
        await interaction.reply('This command cannot be used in DMs.');
        break;
      }

      let tickerOrId = interaction.options.getString('ticker');
      let guild = getGuild(tickerOrId, interaction);

      switch(guild){
        case null:
          await interaction.reply('Server not found (it is likely no longer trading).');
          return;

        case undefined:
          await interaction.reply('Stock ticker or server ID not found.');
          return;
      }

      const serverStockData: GuildStockData = readJSONFile(STOCKDATA)[guild.id];

      if(serverStockData === undefined){
        await interaction.reply('This server does not have a stock price yet (it may take up to a minute before it gets one, if it was just added to the market).');
        break;
      }

      await interaction.reply(
        Discord.bold(readJSONFile(BACKWARDSTICKERS)[guild.id.toUpperCase()] ?? guild.id)
        + ' '
        + Discord.italic(guild.name)
        + ': ₦'
        + (serverStockData.actualPrice).toFixed(0)
      );

      break;
    }

    case 'graph': {

      // TODO /graph

      break;
    }

    case 'setticker': {

      if(interaction.guild === null){
        await interaction.reply('This command cannot be used in DMs.');
        break;
      }

      if(!(interaction.member!.permissions as Discord.PermissionsBitField).has('ManageGuild')){
        await interaction.reply('You do not have permission to run this command.');
        break;
      }

      const ticker = interaction.options.getString('ticker')?.toUpperCase();
      const tickers = readJSONFile(TICKERS);
      const backwardsTickers = readJSONFile(BACKWARDSTICKERS);

      if(ticker === undefined){
        await interaction.reply('No ticker provided.');
        break;
      }

      if(tickers[ticker] !== undefined){
        await interaction.reply('That ticker is already being used.');
        break;
      }

      // TODO Check ticker constraints

      delete tickers[backwardsTickers[interaction.guildId!]];
      tickers[ticker] = interaction.guildId!;
      backwardsTickers[interaction.guildId!] = ticker;
      writeJSONFile(TICKERS, tickers);
      writeJSONFile(BACKWARDSTICKERS, backwardsTickers);

      await interaction.reply(`This server's ticker is now "${ticker}".`);

      break;
    }

    case 'buy': {

      let tickerOrId = interaction.options.getString('ticker');
      let guild = getGuild(tickerOrId, interaction);

      switch(guild){
        case null:
          await interaction.reply('Server not found (it is likely no longer trading).');
          return;

        case undefined:
          await interaction.reply('Stock ticker or server ID not found.');
          return;
      }

      const serverStockData: GuildStockData = readJSONFile(STOCKDATA)[guild.id];
      const volumeLimit = Math.floor(PUBLICAVAILSHARES * serverStockData.sharesLeft);
      const volume = interaction.options.getInteger('volume') ?? 1;

      if(volume > volumeLimit){
        interaction.reply(`You requested ${volume} stocks, but the current limit is ${volumeLimit}. Try again with a smaller volume.`);
        break;
      }

      if(volume <= 0){
        interaction.reply(`Cannot buy a negative or zero number of stocks.`);
        break;
      }

      const price = interaction.options.getInteger('price');

      if(price === null){
        /* TODO Market order */

      } else {
        /* TODO Limit order */
      }

      break;
    }

    case 'sell': {
      // TODO /sell
      break;
    }

    default: {
      await interaction.reply(`Unknown command ${interaction.commandName}`);
      break;
    }
  }
});

client.on('messageCreate', async (message: Discord.Message) => {

  // Do not respond to bots
  if(message.author.bot)
    return;

  let thisServerData = tempMsgData[message.guildId!];

  if(thisServerData === undefined){
    thisServerData = {
      authors: [],
      numMessages: 0
    };
  }

  // If this user hasn't talked since the last update, add them as an author
  if(!thisServerData.authors.includes(message.author.id)){
    thisServerData.authors.push(message.author.id);
  }

  ++thisServerData.numMessages;

  tempMsgData[message.guildId!] = thisServerData;
});

client.on('guildCreate', adjustStockPrice);

////////////////////////////////////////////////////////////////////////////////

// Currently, this updates EVERY MINUTE, on the minute. When changing the frequency, remember to also modify MAXDATAPOINTS.
schedule.scheduleJob('0 * * * * *', () => {
  client.guilds.cache.forEach(adjustStockPrice);
  tempMsgData = {};
});

////////////////////////////////////////////////////////////////////////////////

client.login(process.env.DISCORD_TOKEN);