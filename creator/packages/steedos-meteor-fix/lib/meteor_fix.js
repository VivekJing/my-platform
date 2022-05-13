/*
 * @Author: sunhaolin@hotoa.com
 * @Date: 2021-05-24 12:32:56
 * @LastEditors: sunhaolin@hotoa.com
 * @LastEditTime: 2022-05-13 00:33:40
 * @Description: 
 */
import { Mongo } from 'meteor/mongo'

// Revert change from Meteor 1.6.1 who set ignoreUndefined: true
// more information https://github.com/meteor/meteor/pull/9444
if (Meteor.isServer) {
	process.noDeprecation = true; // silence deprecation warnings, 相当于 --no-deprecation
	let mongoOptions = {
		useUnifiedTopology: true, // Required to silence deprecation warnings
		autoReconnect: undefined,
		reconnectTries: undefined
	};

	const mongoOptionStr = process.env.MONGO_OPTIONS;
	if (typeof mongoOptionStr !== 'undefined') {
		const jsonMongoOptions = JSON.parse(mongoOptionStr);

		mongoOptions = Object.assign({}, mongoOptions, jsonMongoOptions);
	}

	if (process.env.STEEDOS_CSFLE_MASTER_KEY) {
		const pluginFieldEncryption = require('@steedos/ee_plugin-field-encryption');
		const { keyVaultNamespace, getKMSProviders } = pluginFieldEncryption.settings.sharedconst;
		const kmsProvider = getKMSProviders();
		const encryptionOptions = {
			useNewUrlParser: true,
			useUnifiedTopology: true,
			monitorCommands: true,
			autoEncryption: {
				keyVaultNamespace: keyVaultNamespace,
				kmsProviders: kmsProvider,
				bypassAutoEncryption: true,
			}
		}
		mongoOptions = Object.assign({}, mongoOptions, encryptionOptions);
	}

	Mongo.setConnectionOptions(mongoOptions);
}


Meteor.autorun = Tracker.autorun
