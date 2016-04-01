var fs = require('fs')
var util = require('util')
var readline = require('readline')
var bunyan = require('bunyan')
var minimist = require('minimist')

var argv = minimist(process.argv.slice(2), {
  default: {
    'file': '/tmp/openvpn-status.log',
    'consul-http-addr': 'localhost:8500'
  }
})

var consulOpts = {
  host: argv['consul-http-addr'].split(':')[0],
  port: argv['consul-http-addr'].split(':')[1], 
}

if (typeof argv['consul-token'] != 'undefined') {
  consulOpts['defaults'] = {token: argv['consul-token']}
}

var consul = require('consul')(consulOpts)

var logger = bunyan.createLogger({
  name: 'openvpn-registrator',
  level: 'debug'
})

function parseStatus(fileName, callback) {
  var state = null
  var clientStart = false
  var routesStart = false

  var statusObj = {}
  var clientObj = {}
  var routesObj = {}

  var readStream = fs.createReadStream(fileName)
  
  readStream.on('error', callback)
  
  readStream.on('end', function() {
    Object.keys(clientObj).forEach(function(key) {
      statusObj['clients'].push(clientObj[key])
    })

    callback(null, statusObj)
  })
  
  var lineReader = readline.createInterface({
    input: readStream
  })
  
  lineReader.on('error', callback)
  
  lineReader.on('line', function(line) {
    if (line == 'OpenVPN CLIENT LIST') {
      state = 'clients'
    }
    else if (line == 'ROUTING TABLE') {
      state = 'routes'
    }
    else if (line == 'GLOBAL STATS') {
      state = 'stats'
    }

    if (!state) {
      return
    }

    if (state == 'clients') {
      if (line.indexOf('Updated') === 0) {
        statusObj['updated'] = line.split(',')[1]
      }

      if (line.indexOf('Common Name') === 0) {
        clientStart = true
        statusObj['clients'] = []
        return
      }

      if (clientStart == true) {
        var clientParts = line.split(',')

        clientObj[clientParts[0]] = {
          name: clientParts[0],
          address: clientParts[1],
          virtual: null,
          received: clientParts[2],
          sent: clientParts[3],
          connected: clientParts[4],
          updated: null,
        }
      }
      
    }
    else if (state == 'routes') {
      if (line.indexOf('Virtual Address') === 0) {
        routesStart = true
        return
      }

      if (routesStart == true) {
        var routesParts = line.split(',')
        if (typeof clientObj[routesParts[1]] != 'undefined') {
          clientObj[routesParts[1]].virtual = routesParts[0]
          clientObj[routesParts[1]].updated = routesParts[3]
        }
      }
    }
  
    skip = false
  })

}

function handleStatus(err, status) {
  status.clients.forEach(function(client) {
    registerClient(client)
  })  
}

function registerClient(client) {
  var serviceName = 'openvpn-client:' + client.name
  consul.agent.service.list(function(err, services) {
    var serviceFound = false
    Object.keys(services).forEach(function(key) {
      var service = services[key]
      if (service.Tags.indexOf('openvpn-registrator') !== -1 && service.Service == serviceName) {
        serviceFound = true
      }
    })
    
    if (!serviceFound) {
      logger.info({client: client}, 'service not found, proceed with registration')

      var serviceOpts = {
        id: serviceName,
        name: serviceName,
        tags: [
          'openvpn-registrator'
        ],
        address: client.virtual,
        check: {
          notes: 'Indicates whether or not the Dynamic Rig is connected to the VPN',
          ttl: '120s',
          status: 'passing'
        }
      }
      
      logger.debug({service: serviceOpts}, 'service register options')
      
      consul.agent.service.register(serviceOpts, function(err) {
        if (err) {
          return logger.fatal({err: err, service: serviceOpts}, 'unable to register service')
        }

        updateCheck(client)
      })
    } else {
      logger.info({client: client}, 'service found')

      updateCheck(client)
    }

  })
}

function updateCheck(client) {
  logger.debug({client: client}, 'updating TTL check')

  var checkName = 'service:openvpn-client:' + client.name
  
  consul.agent.check.pass({
    id: checkName,
    note: 'Name: ' + client.name + '\nConnected At: ' + client.connected + '\nUpdated At: ' + client.updated
  }, function(err) {
    if (err) {
      return logger.error({err: err}, 'unable to update client health check')
    }
    
    logger.info({client: client}, 'updated client health check')
  })
}

logger.debug({arguments: argv}, 'arguments')

fs.exists(argv['file'], function(ok) {
  if (!ok) {
    logger.error({file: argv['file']}, 'file does not exist')
    process.exit(1)
  }

  parseStatus(argv['file'], handleStatus)

  fs.watchFile(argv['file'], function(curr, prev) {
    parseStatus(argv['file'], handleStatus)
  })
})
