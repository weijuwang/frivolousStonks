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

import * as Discord from 'discord.js'
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as schedule from 'node-schedule'
import * as crypto from 'crypto'
import { Mutex } from 'async-mutex'

dotenv.config({ path: __dirname + '/.env' })
let moment = require('moment')
let plotly = require('plotly')(process.env.PLOTLY_USERNAME, process.env.PLOTLY_APIKEY)

////////////////////////////////////////////////////////////////////////////////
// Types and constructors
////////////////////////////////////////////////////////////////////////////////

type OrderDir   = 'buy' | 'sell'
type OrderType  = 'lim' | 'mkt' | 'ipo'
type UserID     = string
type GuildID    = string
type OrderID    = string
type Ticker     = string
type Volume     = number
type Price      = number

interface Order {
    id:         OrderID | null
    dir:        OrderDir
    type:       OrderType
    userId:     UserID
    guildId:    GuildID
    volume:     Volume
    price:      Price
}

interface LimitOrderBook {
    [key: string]: Order[]
}

interface MarketOrderBook {
    buy:    Order[]
    sell:   Order[]
}

function newUser(userId: UserID){
    data.users[userId] = {
        coins: INIT_COIN_COUNT,
        holdings: {},
        pendingOrders: []
    }
}

function newGuild(guildId: GuildID, ipoPrice: Price){
    data.guilds[guildId] = {
        ticker: guildId,
        trueDataPoints: [ipoPrice],
        truePrice: ipoPrice,
        actualPriceHistTimes: [getCurrTimestamp()],
        actualPriceHist: [ipoPrice],
        lim: {}, // limit orders
        mkt: { // market orders
            buy: [],
            sell: []
        },
        ipo: {
            id: null,
            dir: 'sell',
            type: 'mkt',
            userId: SYSTEM_ID,
            guildId: guildId,
            volume: IPO_NUM_SHARES,
            price: 0
        }
    }
}

/**
 * The buyer or seller does not have enough coins for this transaction.
 */
class NotEnoughCoinsError {

    constructor(party: OrderDir){
        this.party = party      
    }

    party: OrderDir
}

/**
 * The order's volume is too large.
 */
class OrderTooLargeError {}

/**
 * No order with that ID exists.
 */
class InvalidOrderIDError {}

/**
 * Trading is currently stopped.
 */
class TradingStoppedError {}

////////////////////////////////////////////////////////////////////////////////
// Constants
////////////////////////////////////////////////////////////////////////////////

/**
 * Path to the database.
 */
const DATABASE_PATH = 'data.json'

/**
 * The ID that identifies the stock exchange in cases where the exchange is doing something a user would normally do (e.g. selling newly issued stocks).
 */
const SYSTEM_ID = 'system'
 
/**
 * The number of previous data points that the exchange will use to compute true prices.
 */
const MAX_DATA_POINTS = 24 * 60
 
/**
 * The weight with which the true price will pull the actual price.
 */
const TRUE_PRICE_WEIGHT = 0.1

/**
 * The number of shares distributed to the public in a server's IPO.
 */
const IPO_NUM_SHARES = 1000

/**
 * The maximum length of a server's ticker.
 */
const MAX_TICKER_LENGTH = 8
 
/**
 * The number of coins all users are given.
 */
const INIT_COIN_COUNT = 1_000

////////////////////////////////////////////////////////////////////////////////
// Variables
////////////////////////////////////////////////////////////////////////////////

/**
 * This Discord bot.
 */
const client: Discord.Client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
    ]
})

/**
 * Used whenever reading/writing to the database to prevent race conditions.
 */
const globalMutex = new Mutex()

/**
 * Data about server activity.
 */
let activityData = {} as {
    [key: string]: {
        authors:    Set<UserID>
        msgCount:   number
    }
}

/**
 * All of the data that the exchange stores.
 */
let data: {
    users: {
        [key: UserID]: {
            coins:                  Price
            holdings: {
                [key: GuildID]:     Volume
            }
            pendingOrders:          Order[]
        }
    }
    guilds: {
        [key: GuildID]: {
            ticker:                 Ticker
            trueDataPoints:         Price[]
            truePrice:              Price | undefined
            actualPriceHistTimes:   string[]
            actualPriceHist:        Price[]
            lim:                    LimitOrderBook
            mkt:                    MarketOrderBook
            ipo:                    Order | null
        }
    }
    tickers: {
        [key: Ticker]:              GuildID
    }
    trading:                        Boolean
    admins:                         UserID[]
}

////////////////////////////////////////////////////////////////////////////////
// Functions
////////////////////////////////////////////////////////////////////////////////

/**
 * Formula for determining a server's true stock price.
 * The +1 exists so that a server's true price will never hit zero. This is to prevent traders obtaining a dead server's stock for free at its IPO.
 */
function trueStockPriceFormula(memberCount: number, numMessages: number, numAuthors: number){
    return 1 + 10 * Math.log(memberCount) * (numMessages / numAuthors)
}

/**
 * Reads the database into memory.
 */
function readData(){
    data = JSON.parse(fs.readFileSync(DATABASE_PATH).toString())
}

/**
 * Writes the database onto disk.
 */
function writeData(){
    fs.writeFileSync(DATABASE_PATH, JSON.stringify(data))
}

/**
 * Get the current timestamp as a string.
 */
function getCurrTimestamp(): string {
    return moment().format('YYYY-MM-DD HH:mm:ss')
}

/**
 * Get a server's ticker.
 */
function getTicker(guildId: GuildID): Ticker {
    return data.guilds[guildId].ticker ?? guildId
}

/**
 * Get a server's full name (ticker + name).
 */
function getGuildFullName(guild: Discord.Guild): string {
    return Discord.bold(getTicker(guild.id)) + ' ' + Discord.italic(guild.name)
}

/**
 * Get a server's `Guild` object from its ticker or ID.
 * @return `Discord.Guild` A guild exists with this ticker or ID, which has been returned.
 * @return `undefined` The bot has never recorded data from a guild with this ticker or ID (i.e. it doesn't exist).
 * @return `null` The bot has data for this guild, but it can't actually find the guild.
 */
function getGuildFromIdentifier(identifier: Ticker | GuildID): Discord.Guild | undefined | null {

    // Assume `identifier` is a guild ID. Find the guild, if any, that it represents.
    let guild = client.guilds.cache.get(identifier)

    // If no guild with the ID `identifier` was found, `identifier` must be a ticker
    if(guild === undefined){

        // Get the ID that the ticker `identifier` represents
        identifier = data.tickers[identifier]

        // If such a ticker does not exist
        if(identifier === undefined)
            return undefined

        // Find the guild with that ID
        guild = client.guilds.cache.get(identifier)

        // If that guild does not exist anymore
        if(guild === undefined)
            return null
    }

    return guild
}

/**
 * Get the information of a pending order as a string.
 */
function getPendingOrderInfo(order: Order): string {
    return (order.type === 'ipo'
            ? '[IPO]'
            : (order.dir.toUpperCase()
                + ' '
                + order.type.toUpperCase()
            )
        )
        + ' '
        + getTicker(order.guildId)
        + ' x'
        + order.volume
        + (order.type === 'lim' ? (' @ ₦' + order.price) : '')
        + ' ('
        + order.id
        + ')'
}

/**
 * Change a stock's ticker.
 */
function changeTicker(guildId: GuildID, ticker: Ticker){
    delete data.tickers[data.guilds[guildId].ticker]
    data.guilds[guildId].ticker = ticker.toUpperCase()
    data.tickers[ticker] = guildId
}

/**
 * Move a stock's ticker price.
 */
function changePrice(guildId: GuildID, newPrice: Price){
    let guild = data.guilds[guildId]
    guild.actualPriceHist.push(newPrice)
    guild.actualPriceHistTimes.push(getCurrTimestamp())
}

/**
 * Processes an order.
 * @return The order that was entered into the queue, if any.
 * @note Assumes that the user making the order already has user data initialized in the database.
 * @throw `NotEnoughCoinsError` if the buyer/seller does not have enough coins.
 * @throw `OrderTooLargeError` if the buyer does not have that many of the requested stock.
 * @throw `TradingStoppedError` if trading is stopped.
 * 
 * If matching orders exist, they are removed.
 * Any remaining stock unable to be transferred is put in an order in the queue.
 */
function processOrder(order: Order): Order | null {

    let guild = data.guilds[order.guildId]
    let orderUser = data.users[order.userId]
    let oppOrder: Order
    let oppDir: OrderDir = 'sell'
    let direction = 1

    if(!data.trading)
        throw new TradingStoppedError()

    // Don't process empty orders
    if(order.volume <= 0)
        return null

    // User has no holdings in this stock
    if(orderUser.holdings[order.guildId] === undefined)
        orderUser.holdings[order.guildId] = 0

    // All of the code below is written and commented like a buy order.
    // However, a sell order just means that stocks and money flow in the opposite direction.
    if(order.dir === 'sell'){
        oppDir = 'buy'
        direction = -1
    }

    /* If all of the user's pending orders were to be fulfilled right now, would they still have enough coins and stock? */

    if(order.userId !== SYSTEM_ID){
        let orderUserTheoreticalCoins = orderUser.coins
        let orderUserTheoreticalHoldings = orderUser.holdings[order.guildId]

        for(const pendingOrder of orderUser.pendingOrders){
            if(pendingOrder.guildId === order.guildId){
                if(pendingOrder.dir === 'sell'){
                    orderUserTheoreticalHoldings -= pendingOrder.volume
                } else if(pendingOrder.dir === 'buy'
                    && pendingOrder.type === 'lim'){
                    orderUserTheoreticalCoins -= pendingOrder.price
                }
            }
        }

        // User doesn't have enough coins to buy
        if(order.type === 'lim'
            && order.dir === 'buy'
            && orderUserTheoreticalCoins < order.price * order.volume
        )
            throw new NotEnoughCoinsError('buy')

        // User won't have enough stocks to sell
        if(order.dir === 'sell'
            && orderUserTheoreticalHoldings < order.volume
        )
            throw new OrderTooLargeError()
    }

    /**
     * @return Whether the entire buy order was fulfilled.
     */
    function executeOrderPrice(): Boolean {

        let thisPriceQueue = guild.lim[order.price]
        let marketQueue = guild.mkt[oppDir]

        if(thisPriceQueue !== undefined || marketQueue !== undefined || guild.ipo !== null){

            // While there is an IPO, and the order price > the true price
            // or there are market sellers in the queue
            // or there are limit sellers in the queue at this price
            while(((oppOrder = guild.ipo!) !== null
                    && order.dir === 'buy'
                    && order.price >= guild.truePrice!)
                || (marketQueue !== undefined
                    && marketQueue.length > 0
                    && (oppOrder = marketQueue[0]).dir === oppDir)
                || (thisPriceQueue !== undefined
                    && thisPriceQueue.length > 0
                    && (oppOrder = thisPriceQueue[0]).dir === oppDir)
            ){
                let oppUser = data.users[oppOrder.userId]
                const fulfillEntireSellOrder = order.volume >= oppOrder.volume
                const numCoinsTransferred = order.price
                    * (fulfillEntireSellOrder ? oppOrder.volume : order.volume)

                // Take coins from the buyer
                orderUser.coins -= direction * numCoinsTransferred

                // Give those coins to the seller
                oppUser.coins += direction * numCoinsTransferred

                // Take stock from the seller
                oppUser.holdings[order.guildId] -= direction * order.volume

                // Remove the entry for that stock if they have zero stock
                if(oppUser.holdings[order.guildId])
                    delete oppUser.holdings[order.guildId]

                // Give that stock to the buyer
                orderUser.holdings[order.guildId] += direction * order.volume

                changePrice(order.guildId, order.price)

                // If the entire sell order can be fulfilled
                if(fulfillEntireSellOrder){

                    // Decrease the number of stocks to buy in the order
                    order.volume -= direction * oppOrder.volume

                    // Remove the pending sell order in the user
                    oppUser.pendingOrders.splice(
                        oppUser.pendingOrders.findIndex(order => order.id === oppOrder.id)
                    )

                    // Remove the sell order
                    thisPriceQueue.shift()

                    // Exit if the buy order has been completely fulfilled
                    if(order.volume === 0)
                        return true

                } else {
                    // Partially fulfill the sell order
                    oppOrder.volume -= direction * order.volume

                    return true
                }
            }
        } else {
            // Create a queue for this price
            guild.lim[order.price] = []
        }

        return false
    }

    switch(order.type){

        case 'lim':
            if(executeOrderPrice())
                return null
            break

        case 'mkt':
            for(const price of Object.keys(guild.lim)
                .map(p => parseInt(p))
                .sort((a, b) => -1 * direction * (a - b))
            ){
                order.price = price

                if(executeOrderPrice())
                    return null
            }

            guild.lim[order.price] = []
            break
    }

    // If we're here, it means we still want to buy more stock, but no one is selling at that price.
    // Thus, we need to place an order in the queue.
    order.id = crypto.randomBytes(8).toString('hex')

    if(order.type === 'lim')
        guild.lim[order.price].push(order)
    else {
        if(guild.mkt[order.dir] === undefined)
            guild.mkt[order.dir] = []
        guild.mkt[order.dir].push(order)
    }

    orderUser.pendingOrders.push(order)
    console.log(order)
    return order
}

/**
 * Cancel an order.
 */
function cancelOrder(order: Order){

    /* Remove the order from the user's data */
    let pendingOrders = data.users[order.userId].pendingOrders

    const orderIndex = pendingOrders.findIndex(thisOrder => thisOrder.id === order.id)

    if(orderIndex === -1)
        throw new InvalidOrderIDError()

    pendingOrders.splice(orderIndex)

    // Remove the order from the queue
    let queueByType = data.guilds[order.guildId][order.type]
    let queue: Order[]

    if(order.type === 'lim')
        queue = (queueByType as LimitOrderBook)[order.price]
    else
        queue = (queueByType as MarketOrderBook)[order.dir]

    queue.splice(queue.findIndex(thisOrder => thisOrder.id === order.id))
}

// Every minute, on the minute
schedule.scheduleJob('0 * * * * *', async () => {

    await globalMutex.runExclusive(async () => {

        readData()

        // For each listed guild, adjust its price
        client.guilds.cache.forEach(guild => {

            // Defaults (meaning zero activity)
            let numMessages = 0
            let numAuthors = 1

            if(guild.id in activityData){
                numMessages = activityData[guild.id].msgCount
                numAuthors = activityData[guild.id].authors.size
            }

            let thisGuild = data.guilds[guild.id]

            // If this server already has data
            if(thisGuild !== undefined){

                let newData = thisGuild.trueDataPoints

                // Add data from the last minute
                newData.unshift(trueStockPriceFormula(guild.memberCount, numMessages, numAuthors))

                // Remove the oldest data point
                if(newData.length > MAX_DATA_POINTS)
                    newData.pop()

                // Compute the current true price
                thisGuild.truePrice = newData.reduce((a, b) => a + b) / newData.length

                // Pull the actual price towards the true price
                changePrice(guild.id,
                    (thisGuild.actualPriceHist.at(-1)! + thisGuild.truePrice * TRUE_PRICE_WEIGHT)
                    / (TRUE_PRICE_WEIGHT + 1)
                )
            } else {
                // This is the first time we've collected data from this server
                newGuild(guild.id, trueStockPriceFormula(guild.memberCount, numMessages, numAuthors))
            }
        })

        // Reset temporary data
        activityData = {}

        writeData()
    })
})

// When the bot starts
client.on('ready', async () => {
    console.log(`Ready! Add with https://discord.com/api/oauth2/authorize?client_id=${client!.user!.id}&permissions=2147485697&scope=bot`)
})

// When a command is sent
client.on('interactionCreate', async (interaction: Discord.Interaction) => {

    if(!interaction.isChatInputCommand())
        return

    await globalMutex.runExclusive(async () => {

        readData()

        // Init this user's data, if they don't have any
        if(!(interaction.user.id in data.users))
            newUser(interaction.user.id)

        let thisUser = data.users[interaction.user.id]

        await (async () => {
            try {
                switch(interaction.commandName){
    
                    /**
                     * Ping the bot (test whether it is online).
                     */
                    case 'ping': {
                        await interaction.reply('pong')
                        return
                    }
    
                    /**
                     * Display the price of a stock.
                     */
                    case 'price': {
    
                        if(interaction.guild === null){
                            await interaction.reply('This command cannot be used in DMs.')
                            return
                        }
    
                        const identifier = interaction.options.getString('ticker') ?? interaction.guildId!
                        const guild = getGuildFromIdentifier(identifier)
    
                        switch(guild){
                            case null:
                                await interaction.reply('Server not found (likely no longer trading).')
                                return
    
                            case undefined:
                                await interaction.reply('Stock ticker or server ID not found.')
                                return
                        }
    
                        const guildStockData = data.guilds[guild.id]
    
                        if(guildStockData === undefined){
                            await interaction.reply('This server does not have a stock price yet, as it was just added; it may take up to a minute before it gets one.')
                            return
                        }
    
                        await interaction.reply(
                            getGuildFullName(guild)
                            + ': ₦'
                            + guildStockData.actualPriceHist.at(-1)!.toFixed(0)
                        )
    
                        return
                    }
    
                    /**
                     * Display account balance in coins.
                     */
                    case 'balance': {
                        await interaction.reply(`${Discord.bold('Balance:')} ₦${thisUser.coins}`)
                        return
                    }
    
                    /**
                     * Display all account information.
                     */
                    case 'account': {
    
                        let output = `${Discord.underscore('Balance')}\n₦${thisUser.coins}\n\n`
                            + Discord.underscore('Holdings') + '\n'
    
                        for(const guildId in thisUser.holdings)
                            output += thisUser.holdings[guildId]
                                + 'x'
                                + getGuildFullName(
                                    getGuildFromIdentifier(guildId)!
                                )
                                + '\n'
    
                        output += '\n' + Discord.underscore('Pending orders') + '\n'
    
                        for(const orderId in thisUser.pendingOrders)
                            output += getPendingOrderInfo(thisUser.pendingOrders[orderId]) + '\n'
    
                        await interaction.reply(output)
                        return
                    }
    
                    /**
                     * Buy/sell stock.
                     */
                    case 'buy':
                    case 'sell': {
                        const identifier = interaction.options.getString('ticker')!.toUpperCase()
                        let guild = getGuildFromIdentifier(identifier!)
    
                        switch(guild){
                            case null:
                                await interaction.reply('Server not found (likely no longer trading).')
                                return
                            case undefined:
                                await interaction.reply('Stock ticker or server ID not found.')
                                return
                        }
    
                        const thisGuild = data.guilds[guild.id]
    
                        if(thisGuild === undefined){
                            await interaction.reply('This stock was just added to the exchange and cannot be traded until the beginning of the next minute.')
                            return
                        }
    
                        const volume = interaction.options.getInteger('volume') ?? 1
    
                        if(volume <= 0){
                            await interaction.reply('Cannot buy a zero or negative number of stocks.')
                            return
                        }
    
                        const price = interaction.options.getInteger('price')
                        const isMktOrder = price === null
    
                        const pendingOrder = processOrder({
                            id: null,
                            dir: interaction.commandName,
                            type: isMktOrder ? 'mkt' : 'lim',
                            userId: interaction.user.id,
                            guildId: guild.id,
                            volume: volume,
                            price: isMktOrder ? 0 : price
                        })

                        if(pendingOrder === null)
                            await interaction.reply(`You ${interaction.commandName === 'buy' ? 'bought' : 'sold'} ${volume} shares of ${getGuildFullName(guild)}.`)
                        else
                            await interaction.reply(
                                `You have placed the following order:\n `
                                + getPendingOrderInfo(pendingOrder) + '\n'
                                + 'This may take an indefinite amount of time to go through depending on market conditions.'
                            )
                            // TODO DM the user when their order goes through
                        return
                    }

                    /**
                     * Display information for a pending order.
                     */
                    case 'orderinfo': {

                        const orderId = interaction.options.getString('orderid')!
                        const pendingOrder = data.users[interaction.user.id].pendingOrders.find(order => order.id === orderId)

                        if(pendingOrder === undefined)
                            throw new InvalidOrderIDError()

                        await interaction.reply(getPendingOrderInfo(pendingOrder))
                        return
                    }
    
                    /**
                     * Cancel an order.
                     */
                    case 'cancel': {

                        const orderId = interaction.options.getString('orderid')!
                        const pendingOrder = data.users[interaction.user.id].pendingOrders.find(order => order.id === orderId)

                        if(pendingOrder === undefined)
                            throw new InvalidOrderIDError()

                        cancelOrder(pendingOrder)
                        await interaction.reply('Your order has been canceled.')
                        return
                    }
    
                    /**
                     * Set a server's ticker (requires `MANAGE_SERVER`).
                     */
                    case 'setticker': {
    
                        if(interaction.guild === null){
                            await interaction.reply('This command cannot be used in DMs.')
                            return
                        }
    
                        if(!(interaction.member!.permissions as Discord.PermissionsBitField).has('ManageGuild')){
                            await interaction.reply('You do not have permission to run this command.')
                            return
                        }
    
                        if(!(interaction.guildId! in data.guilds)){
                            await interaction.reply('This server has not been listed yet, and it will not have a ticker until the beginning of the next minute.')
                            return
                        }
    
                        const ticker = interaction.options.getString('ticker')!.toUpperCase()
    
                        if(data.tickers[ticker] !== undefined){
                            await interaction.reply('That ticker is already being used.')
                            return
                        }
    
                        if(ticker.length > MAX_TICKER_LENGTH){
                            await interaction.reply('Tickers may not be more than 8 characters long.')
                            return
                        }
    
                        if(!/^[A-Za-z0-9]*$/.exec(ticker)){
                            await interaction.reply('Tickers may only consist of letters and numbers.')
                            return
                        }
    
                        changeTicker(interaction.guildId!, ticker)
    
                        await interaction.reply(`This server's ticker is now "${ticker}".`)
                        return
                    }

                    /**
                     * Stop the entire exchange.
                     */
                    case 'stoptrading': {
                        if(data.admins.includes(interaction.user.id)){
                            data.trading = false
                            await interaction.reply('Trading has been stopped.')
                        } else {
                            await interaction.reply('You are not an exchange administrator and cannot perform this action.')
                        }
                        return
                    }

                    /**
                     * Resume the exchange.
                     */
                    case 'conttrading': {
                        if(data.admins.includes(interaction.user.id)){
                            data.trading = true
                            await interaction.reply('Trading has been resumed.')
                        } else {
                            await interaction.reply('You are not an exchange administrator and cannot perform this action.')
                        }
                        return
                    }
                }
            } catch(error){
                if(error instanceof NotEnoughCoinsError){
                    await interaction.reply('You do not have enough coins for that transaction.')
                    return
                } else if(error instanceof OrderTooLargeError){
                    await interaction.reply('You don\'t have that many shares to sell.')
                    return
                } else if(error instanceof InvalidOrderIDError){
                    await interaction.reply('You do not have an order with that ID.')
                    return
                } else if(error instanceof TradingStoppedError){
                    await interaction.reply('Trading has been stopped temporarily by an exchange administrator.')
                    return
                }
                throw error
            }
        })()

        writeData()
    })
})

// When a message is sent
client.on('messageCreate', async (message: Discord.Message) => {

    // Do not respond to bots
    if(message.author.bot)
        return

    globalMutex.runExclusive(async () => {

        let thisGuildData = activityData[message.guildId!]

        if(thisGuildData === undefined)
            thisGuildData = {
                authors: new Set(),
                msgCount: 0
            }

        // If this user hasn't sent a message since the last update, add them as an author
        thisGuildData.authors.add(message.author.id)

        ++thisGuildData.msgCount
    })
})

client.login(process.env.DISCORD_TOKEN)