/*jslint node: true, white: false, continue: true, passfail: false, nomen: true, plusplus: true, maxerr: 50, indent: 4 */

var exports, util, async, collections, actorUniqueProps, activityIdProps, collectionNames, mongodb, dbName, sys, config;
util = require('./util.js');
config = require('./config.js');
sys = require('util');
mongodb = require('mongodb');
async = require('async');
collections = {};
dbName = "";

collectionNames = ['statements', 'actors', 'activities', 'state', 'activity_profile', 'actor_profile'];
actorUniqueProps = ['mbox', 'account', 'holdsAccount', 'openid', 'weblog', 'homepage', 'yahooChatID', 'aimChatID', 'skypeID', 'mbox_sha1sum'];
activityIdProps = ['id', 'platform', 'revision'];

exports.collections = collections;

function errorCallback(message, status, callback) {
	"use strict";
	var error = new Error(message);
	error.HTTPStatus = status;
	if (callback) {
		callback(error);
	} else {
		throw error;
	}
}

// merges source into target, returns true if target is updated.
// exception if source and target contain contradictary information
function mergeActivities(source, target, onlyEmpty) {
	"use strict";
	var modified, property;
	modified = false;

	for (property in source) {
		if (source.hasOwnProperty(property) && property !== '_id' && !util.inList(property, activityIdProps)) {
			if (target[property] === undefined) {
				target[property] = source[property];
				modified = true;
			} else if (!(onlyEmpty) && target[property] !== source[property] && JSON.stringify(target[property]) !== JSON.stringify(source[property])) {
				throw new Error('Activity : "' + source.id + '", conflicting values of: ' + property);
			}
		}
	}

	return modified;
}

function getDescendantActivityIds(ids, callback) {
	"use strict";
	var ii, jj, id, definition,
		childIds = [];

	collections.activities.find({ id : {$in : ids } }).toArray(function (error, results) {
		if (error) {
			callback(error);
		} else if (results.length > 0) {
			for (ii = 0; ii < results.length; ii++) {
				definition = results[ii].definition;
				if (definition !== undefined && definition.children !== undefined && definition.children.length > 0) {
					for (jj = 0; jj < definition.children.length; jj++) {
						id = definition.children[jj].id;
						if (!util.inList(id, childIds)) {
							childIds.push(id);
						}
					}
				}
			}
			if (childIds.length > 0) {
				getDescendantActivityIds(childIds, function (error, results) {
					if (error) {
						callback(error);
					} else if (results.length > 0) {
						for (ii = 0; ii < results.length; ii++) {
							if (!util.inList(results[ii], childIds)) {
								childIds.push(results[ii]);
							}
						}
					}
					callback(null, childIds);
				});
			} else {
				callback(null, []);
			}
		} else {
			callback(null, []);
		}
	});
}

function hasActorUniqueProperty(actor) {
	"use strict";
	var jj;

	for (jj = 0; jj < actorUniqueProps.length; jj++) {
		if (actor[actorUniqueProps[jj]] !== undefined) {
			return true;
		}
	}
	return false;
}

function hasActivityIdProperty(activity) {
	"use strict";
	var jj;

	for (jj = 0; jj < activityIdProps.length; jj++) {
		if (activity[activityIdProps[jj]] !== undefined) {
			return true;
		}
	}
	return false;
}

// find matching actors in db
// returns error, array of matching actors
function findActorMatches(actors, callback) {
	"use strict";
	async.map(actorUniqueProps, function (property, callback) {
		var ii, ids, query;
		ids = [];
		for (ii = 0; ii < actors.length; ii++) {
			if (actors[ii][property] !== undefined && !util.inList(actors[ii][property], ids)) {
				ids.push(actors[ii][property]);
			}
		}

		if (ids.length > 0) {
			query = {};
			query[property] = { $in : ids };
			collections.actors.find(query).toArray(callback);
		} else {
			callback(null, []);
		}
	}, function (error, results) {
		var uniqueResults, ii, jj, kk, found, actor;
		uniqueResults = [];

		if (error !== null && error !== undefined) {
			callback(error);
		}

		// coalesce results
		for (ii = 0; ii < results.length; ii++) {
			for (jj = 0; jj < results[ii].length; jj++) {
				actor = results[ii][jj];
				if (actor !== undefined) {
					found = false;
					for (kk = 0; kk < uniqueResults.length; kk++) {
						if (String(actor._id) === String(uniqueResults[kk]._id)) {
							found = true;
							break;
						}
					}
					if (!found) {
						uniqueResults.push(actor);
					}
				}
			}
		}

		callback(null, uniqueResults);
	});
}

// store activity
function storeActivities(activities, callback) {
	"use strict";
	var ii, uniqueActivities, flatActivities, uniqueActivityIDs, activity, updates, children;

	uniqueActivities = {};
	uniqueActivityIDs = [];
	flatActivities = []; // flattened list of activities + children

	while (activities.length > 0) {
		activity = activities.pop();
		if (activity !== undefined) {
			flatActivities.push(activity);
			if (activity.definition !== undefined && activity.definition.children !== undefined) {
				children = activity.definition.children;
				for (ii = 0; ii < children.length; ii++) {
					activities.push(children[ii]); // store children as well as top level activities
				}
			}
			// it's possible to have multiple references to the same activity in a set of statements, get unique list
			if (uniqueActivities[activity.id] === undefined) {
				uniqueActivities[activity.id] = activity;
				uniqueActivityIDs.push(activity.id);
			} else {
				mergeActivities(activity, uniqueActivities[activity.id]);
			}
		}
	}

	collections.activities.find({ id : { $in : uniqueActivityIDs } }).toArray(function (error, dbActivities) {
		var dbActivityMap, id;

		updates = [];

		if (error !== null) {
			callback(error);
		} else {
			dbActivityMap = {};
			for (ii = 0; ii < dbActivities.length; ii++) {
				dbActivityMap[dbActivities[ii].id] = dbActivities[ii];
			}

			for (ii = 0; ii < uniqueActivityIDs.length; ii++) {
				id = uniqueActivityIDs[ii];
				if (dbActivityMap[id] === undefined) {
					updates.push(uniqueActivities[id]);
				} else if (mergeActivities(uniqueActivities[id], dbActivityMap[id])) {
					updates.push(dbActivityMap[id]);
				}
			}

			if (updates.length > 0) {
				async.map(updates, function (update, callback) {
					if (config.verbose) {
						console.log('saving activity: ' + JSON.stringify(update, null, 4));
					}
					collections.activities.save(update, { safe : true, upsert : true},  callback);
				}, callback);
			} else {
				callback();
			}
		}
	});
}

function mergeActors(source, target) {
	"use strict";
	var prop;

	// if equivilant, copy new information about this actor to the existing instance
	if (util.areActorsEqual(source, target)) {
		for (prop in source) {
			if (source.hasOwnProperty(prop) && prop !== '_id') {
				if (target[prop] === undefined) {
					target[prop] = source[prop];
				} else if (target[prop] !== source[prop] && JSON.stringify(target[prop]) !== JSON.stringify(source[prop])) {
					console.log('Actor redefines "' + prop + '" : ' + JSON.stringify(source, null, 4));
				}
			}
		}
		// note the ID of the merged actor
		if (target._id !== undefined) {
			source._id = target._id;
		}
		return true;
	} else {
		return false;
	}
}

function storeUniqueActors(actors, callback) {
	"use strict";

	if (actors.length === 0) {
		// nothting to do, report success
		callback();
	}

	// identify any matching actors in DB, merge & update, for each inverse functional property
	findActorMatches(actors, function (err, results) {
		// results is a list of all matching actors, iterate through and merge matches 
		var ii, jj, duplicates, updates;

		duplicates = [];
		updates = [];

		if (err !== undefined && err !== null) {
			callback(err);
		} else {
			for (ii = 0; ii < actors.length; ii++) {
				for (jj = 0; jj < results.length; jj++) {
					if (mergeActors(actors[ii], results[jj])) {
						updates.push(results[jj]);
						duplicates.push(ii);
					}
				}
			}

			// in addition to merged actors, save all actors with no match
			for (ii = 0; ii < actors.length; ii++) {
				if (!util.inList(ii, duplicates)) {
					updates.push(actors[ii]);
					if (config.verbose) {
						console.log('storing new actor: ' + JSON.stringify(actors[ii]));
					}
				}
			}

			async.map(updates, function (update, callback) {
				collections.actors.save(update, { safe : true, upsert : true }, function (error, result) {
					if (error !== null && error !== undefined) {
						callback(error);
					} else {
						// key of new actor must be stored in actor object so it can be saved in associated statement for actor filtering
						update._id = result._id;
						callback();
					}
				});
			}, callback);
		}
	});
}

function storeActors(actors, callback) {
	"use strict";
	var ii, jj, uniqueActors, isUnique;

	uniqueActors = [];
	for (ii = 0; ii < actors.length; ii++) {
		if (actors[ii] !== undefined) {
			isUnique = true;

			if (!hasActorUniqueProperty(actors[ii])) {
				callback(new Error('Actor has no members which have the inverse functional property (actor is not uniquely identified): ' + JSON.stringify(actors[ii])));
				return;
			}

			for (jj = 0; jj < uniqueActors.length; jj++) {
				if (mergeActors(actors[ii], uniqueActors[jj])) {
					isUnique = false;
					break;
				}
			}

			if (isUnique) {
				uniqueActors.push(actors[ii]);
			}
		}
	}

	storeUniqueActors(uniqueActors, function (error) {
		if (error !== undefined && error !== null) {
			callback(error);
		} else {
			for (ii = 0; ii < uniqueActors.length; ii++) {
				for (jj = 0; jj < actors.length; jj++) {
					if (actors[jj] !== undefined && util.areActorsEqual(actors[jj], uniqueActors[ii])) {
						actors[jj]._id = uniqueActors[ii]._id;
					}
				}
			}

			callback();
		}
	});
}

function areActivitiesEqual(activity1, activity2) {
	"use strict";
	var ii, prop;
	for (ii = 0; ii < activityIdProps; ii++) {
		prop = activityIdProps[ii];
		if (activity1[prop] !== activity2[prop]) {
			return false;
		}
	}

	return true;
}

// are the objects (objects of a statement) equal
function areStatementObjectsEqual(obj1, obj2) {
	"use strict";
	if (obj1.id !== undefined) {
		return areActivitiesEqual(obj1, obj2);
	} else {
		return util.areActorsEqual(obj1, obj2);
	}
}

function areStatementsEqual(statement1, statement2) {
	"use strict";
	var prop;

	if (statement1._id !== statement2._id) {return false; }

	for (prop in statement1) {
		if (statement1.hasOwnProperty(prop)) {
			if (statement1[prop] !== statement2[prop]) {
				if (prop === 'actor' && util.areActorsEqual(statement1.actor, statement2.actor)) {continue; }
				if (prop === 'object' && areStatementObjectsEqual(statement1.object, statement2.object)) {continue; }
				if (prop === 'stored') {continue; }

				if (statement2[prop] === undefined || JSON.stringify(statement1[prop]) !== JSON.stringify(statement2[prop])) {
					console.log('Statement mismatch on "' + prop + '", statement : ' + JSON.stringify(statement1));
					return false;
				}
			}
		}
	}

	return true;
}

/*
stores unique statements that have already been processed (activities, actors, sub-statements to store have been identified)
*/
function storeProcessedStatements(statements, callback) {
	"use strict";
	var IDs, dbStatementMap, ii, newStatements, statement;

	IDs = [];

	// find statements that already exist in the DB
	for (ii = 0; ii < statements.length; ii++) {
		if (!IDs.hasOwnProperty(statements[ii]._id)) {
			IDs.push(statements[ii]._id);
		}
	}

	collections.statements.find({ _id : { $in : IDs } }).toArray(function (error, dbStatements) {
		if (error !== null && error !== undefined) {
			callback(error);
		} else {
			dbStatementMap = {};
			newStatements = [];

			while (dbStatements.length > 0) {
				statement = dbStatements.pop();
				dbStatementMap[statement._id] = statement;
			}
			// only store new statements (that have not already been stored)
			while (statements.length > 0) {
				statement = statements.pop();
				if (dbStatementMap[statement._id] === undefined) {
					newStatements.push(statement);
				} else if (!areStatementsEqual(statement, dbStatementMap[statement._id])) {
					errorCallback('Attempt to redefine statement: ' + statement._id, 409, callback);
					return;
				}
			}

			if (newStatements.length > 0) {
				for (ii = 0; ii < newStatements.length; ii++) {
					if (newStatements[ii].actor._id === undefined) {
						callback(new Error('internal error: undefined actor id -- ' + JSON.stringify(newStatements[ii], null, 4)));
					}
				}
				collections.statements.insert(newStatements, { safe : true}, callback);
			} else {
				callback();
			}
		}
	});
}

// when returning statements, the specified level of detail should be used, if sparse activities & actors should only be included by ID,
// if not sparse complete first level of activity & actor should be included
function normalizeStatements(statements, sparse, callback) {
	"use strict";
	var ii, id, activityIds, activities, actors, prop;

	activityIds = [];
	activities = [];
	actors = [];

	// db uses _id for primary key, spec expects id
	for (ii = 0; ii < statements.length; ii++) {
		statements[ii].id = statements[ii]._id;
		delete statements[ii]._id;

		util.addStatementActivities(statements[ii], activities);
		util.addStatementActors(statements[ii], actors);
	}

	// remove data other than IDs from actors & activities if sparse
	if (sparse) {
		for (ii = 0; ii < actors.length; ii++) {
			for (prop in actors[ii]) {
				if (actors[ii].hasOwnProperty(prop)) {
					if (!util.inList(prop, actorUniqueProps)) {
						delete actors[ii][prop];
					}
				}
			}
		}
		for (ii = 0; ii < activities.length; ii++) {
			for (prop in activities[ii]) {
				if (activities[ii].hasOwnProperty(prop) && !util.inList(prop, activityIdProps)) {
					delete activities[ii][prop];
				}
			}
		}
		callback(null);
	} else {
		// not sparse, add statement & activity detail
		for (ii = 0; ii < activities.length; ii++) {
			id = activities[ii].id;
			if (!util.inList(id, activityIds)) {
				activityIds.push(id);
			}
		}

		// activity detail
		exports.collections.activities.find({ id : { $in : activityIds } }).toArray(function (error, dbActivities) {
			var ii, jj, kk, children, prop;

			if (error !== null && error !== undefined) {
				callback(error);
				return;
			}

			for (ii = 0; ii < dbActivities.length; ii++) {
				for (jj = 0; jj < activities.length; jj++) {
					if (dbActivities[ii].id === activities[jj].id) {
						mergeActivities(dbActivities[ii], activities[jj], true);

						// even for non-sparse, don't include activity child detail
						if (activities[jj].definition !== undefined && activities[jj].definition.children !== undefined) {
							children = activities[jj].definition.children;

							for (kk = 0; kk < children.length; kk++) {
								for (prop in children[kk]) {
									if (children[kk].hasOwnProperty(prop) && prop !== 'id') {
										delete children[kk][prop];
									}
								}
							}
						}
					}
				}
			}

			// actor detail
			findActorMatches(actors, function (error, results) {
				if (error !== null && error !== undefined) {
					callback(error);
				} else {
					for (ii = 0; ii < actors.length; ii++) {
						for (jj = 0; jj < results.length; jj++) {
							if (mergeActors(results[jj], actors[ii])) {
								break;
							}
							// even when returning actor detail, don't include internal ID
							delete actors[ii]._id;
						}
					}
					callback(null);
				}
			});
		});
	}
}

/*
add the specified query condition, properly placing it directly on the propery being
queried on if there are no other conditions on that property, or as part of the $and
property if there is already a condition on the property being queried (and move the 
old condition under $and instead of its property)
*/
function addQueryCondition(property, condition, query) {
	"use strict";
	var conditionObj, oldConditionObj;
	conditionObj = {};
	oldConditionObj = {};
	conditionObj[property] = condition;

	if (query[property] === undefined && (query.$and === undefined || !util.hasElementWithProperty(query.$and, property))) {
		query[property] = condition;
	} else {
		if (query[property] !== undefined) {
			oldConditionObj[property] = query[property];
			delete query[property];

			if (query.$and === undefined) {
				query.$and = [oldConditionObj];
			} else {
				query.$and.push(oldConditionObj);
			}
		}
		query.$and.push(conditionObj);
	}
}

function getActorKeys(props, callback) {
	"use strict";
	var conditionProp, condition, query, ii;
	query = {$or : []};

	// populate list of actors with all known inverse functional properties
	for (conditionProp in props) {
		if (props.hasOwnProperty(conditionProp)) {
			for (ii = 0; ii < props[conditionProp].length; ii++) {
				condition = {};
				condition[conditionProp] = props[conditionProp][ii];
				query.$or.push(condition);
			}
		}
	}

	if (query.$or.length > 0) {
		exports.collections.actors.find(query).toArray(callback);
	} else {
		callback(null, []);
	}
}

function addActorUniqueProps(actor, props) {
	"use strict";
	var prop;

	for (prop in actor) {
		if (actor.hasOwnProperty(prop)) {
			if (util.inList(prop, actorUniqueProps)) {
				if (props[prop] === undefined) {
					props[prop] = [];
				}
				if (!util.inList(actor[prop], props[prop])) {
					props[prop].push(actor[prop]);
				}
			}
		}
	}
}

function addQueryActorConditions(actorConditions, query, callback) {
	"use strict";
	var props, conditionName, ii, found;
	props = {};

	// build list of all inverse functional properties (and values) in specified actor conditions
	for (conditionName in actorConditions) {
		if (actorConditions.hasOwnProperty(conditionName)) {
			addActorUniqueProps(actorConditions[conditionName], props);
		}
	}

	getActorKeys(props, function (error, dbActors) {
		var idCondition, conditionName;
		// use db actors to add actor IDs to main query
		if (error !== null && error !== undefined) {
			callback(error);
			return;
		}

		for (conditionName in actorConditions) {
			if (actorConditions.hasOwnProperty(conditionName)) {
				found = false;
				for (ii = 0; ii < dbActors.length; ii++) {

					if (util.areActorsEqual(actorConditions[conditionName], dbActors[ii])) {
						if (found === true) {
							callback(new Error('Inconsistant data, multiple actors match ' + JSON.stringify(actorConditions[conditionName], null, 4)));
							return;
						}
						found = true;
						idCondition = {};
						idCondition[conditionName + '._id'] = dbActors[ii]._id;
						if (query.$and === undefined) {
							query.$and = [];
						}
						query.$and.push(idCondition);
					}
				}
				if (!found) {
					query.INVALID_ACTOR_FILTER = 'true';
					console.error('Unknown actor, no statements will match: ' + JSON.stringify(actorConditions[conditionName], null, 4));
				}
			}
		}
		callback();
	});
}

function buildStatementObjectQuery(parameters, actorConditions, query) {
	"use strict";
	var object, ii;

	object = parameters.object;

	if (hasActivityIdProperty(object)) {
		for (ii = 0; ii < activityIdProps.length; ii++) {
			if (object[activityIdProps[ii]] !== undefined) {
				query['object.' + activityIdProps[ii]] = object[activityIdProps[ii]];
			}
		}
	} else if (hasActorUniqueProperty(object)) {
		// filter based on actor
		actorConditions.object = object;
	} else {
		throw new Error("Object specified in query is neither valid as an activity nor an actor filter. " + JSON.stringify(object));
	}
}

function buildStatementQuery(parameters, callback) {
	"use strict";
	var query, parameter, actorConditions, descendants;
	query = {};
	actorConditions = {};
	descendants = false;

	if (config.verbose) {
		console.log('Get statements parameters: ' + sys.inspect(parameters));
	}

	for (parameter in parameters) {
		if (parameters.hasOwnProperty(parameter) && !util.inList(parameter, ['limit', 'sparse', 'offset'])) {
			switch (parameter.toLowerCase()) {
			case 'id':
				query._id = parameters.id;
				break;
			case 'verb':
				query.verb = parameters.verb.toLowerCase();
				break;
			case 'object':
				try {
					buildStatementObjectQuery(parameters, actorConditions, query);
				} catch (ex) {
					callback(ex);
					return;
				}
				break;
			case 'registration':
				query.registration = parameters.registration.toLowerCase();
				break;
			case 'since':
				addQueryCondition('stored', { $gt : new Date(parameters.since)}, query);
				break;
			case 'until':
				addQueryCondition('stored', { $lte : new Date(parameters.until)}, query);
				break;
			case 'authoritative':
				console.error("\nWARNING: this LRS considers all statements to be authoritative!\n");
				break;
			case 'actor':
				actorConditions.actor = parameters.actor;
				break;
			case 'instructor':
				actorConditions['context.instructor'] = parameters.instructor;
				break;
			case 'team':
				actorConditions['context.team'] = parameters.team;
				break;
			case 'descendants':
				if (parameters.descendants === 'true') {
					descendants = true;
				} else if (parameters.descendants === 'false') {
					descendants = false;
				} else {
					errorCallback('Unexpected value for "descendants" parameter: ' + parameters.descendants, 400, callback);
					return;
				}
				break;
			default:
				errorCallback('Unexpected get statements parameter: ' + parameter, 400, callback);
				return;
			}
		}
	}

	addQueryActorConditions(actorConditions, query, function (error) {
		var activityId;

		if (error !== null && error !== undefined) {
			callback(error);
		}

		if (descendants) {
			if (query["object.id"] === undefined) {
				errorCallback('Descendants flag used but no activity is specified.', 400, callback);
				return;
			}
			activityId = query["object.id"];
			delete query["object.id"];

			getDescendantActivityIds([activityId], function (error, ids) {
				if (error) {
					callback(error);
					return;
				}

				ids.push(activityId);
				if (query.$or === undefined) {
					query.$or = [];
				}
				query.$or.push({ "object.id" : { $in : ids }});
				query.$or.push({ "context.activity.id" : { $in : ids }});
				if (config.verbose) {
					console.log('query: ' + sys.inspect(query));
				}
				callback(null, query);
			});
		} else {
			if (config.verbose) {
				console.log('query: ' + sys.inspect(query));
			}
			callback(null, query);
		}
	});
}

function handleKVPRequest(requestContext, key, multirow, collection) {
	"use strict";
	var method, response, collectionName, now, since;
	method = requestContext.request.method;
	response = requestContext.response;
	now = new Date();
	since = requestContext.queryString.since;

	function query(key) {
		var queryExp, prop;
		queryExp = {};
		for (prop in key) {
			if (key.hasOwnProperty(prop)) {
				queryExp["_id." + prop] = key[prop];
			}
		}

		if (since !== null && since !== undefined) {
			queryExp.updated = { $gt : new Date(since)};
		}

		if (config.verbose) {
			console.log(JSON.stringify(queryExp, null, 4));
		}

		return queryExp;
	}

	try {
		collectionName = collection.collectionName;
		if (method === 'PUT') {
			util.loadRequestBody(requestContext.request, function (error, data) {
				if (!util.checkError(error, requestContext.request, response, "parsing request to store " + collectionName + " object")) {
					return;
				}
				collection.save({_id : key, data : data, updated: now}, { safe : true }, function (error) {
					if (util.checkError(error, requestContext.request, response, "storing " + collectionName + " object")) {
						response.statusCode = 204;
						response.end('');
					}
				});
			});
		} else if (method === 'DELETE') {
			collection.remove(query(key, since), { safe : true }, function (error) {
				if (util.checkError(error, requestContext.request, response, "clearing " + collectionName + " object")) {
					response.statusCode = 204;
					response.end('');
				}
			});
		} else {
			// then get
			collection.find(query(key, since)).toArray(function (error, result) {
				var ids = [],
					ii;
				if (util.checkError(error, requestContext.request, response, "loading " + collectionName + " object")) {
					response.statusCode = 200;
					if (result.length === 0) {
						response.statusCode = 404;
						response.end();
					} else if (result.length === 1 && !multirow) {
						response.end(result[0].data);
					} else if (multirow) {
						for (ii = 0; ii < result.length; ii++) {
							ids.push(result[ii]._id.key);
						}
						response.end(JSON.stringify(ids, null, 4));
					} else {
						util.checkError(new Error('Unexpected object count: ' + result.length), requestContext.request, response, "loading " + collectionName + " object");
					}
				}
			});
		}
	} catch (ex) {
		console.error('error');
		util.checkError(ex, requestContext.request, response);
	}
}

function getActorId(actor, callback) {
	"use strict";
	var props, id;
	props = {};

	addActorUniqueProps(actor, props);
	getActorKeys(props, function (error, actorKeys) {
		if (error !== null && error !== undefined) {
			callback(error);
			return;
		}
		if (actorKeys.length === 0) {
			callback(new Error('Actor not found: ' + JSON.stringify(actor, null, 4)));
			return;
		} else if (actorKeys.length === 1) {
			id = actorKeys[0]._id;
		} else {
			callback(new Error('Found multiple actors matching: ' + JSON.stringify(actor, null, 4)));
			return;
		}
		callback(null, id);
	});
}

function init(dbNameParam, initCallback) {
	"use strict";
	var db, storage, mongoserver;

	dbName = dbNameParam;
	mongoserver = new mongodb.Server('localhost', mongodb.Connection.DEFAULT_PORT);
	db = new mongodb.Db(dbName, mongoserver);
	storage = exports;

	db.open(function (err, db) {
		if (err !== null) {
			throw err;
		}

		storage.db = db;

		// version 2.0.0 + is required for $and support, needed for statement GET api.
		/*jslint evil: true */ // necessary evil -- no version call in mongo driver. using a literal, so safe.
		db['eval']('db.version()', function (error, result) {
			/*jslint evil: false */
			if (error !== null) {
				initCallback(error);
				return;
			} else {
				console.log('Mongo DB version: ' + result);
				if (parseInt(result, 10) < 2) {
					console.error('Mongo DB 2.0.0 or later required.');
					return;
				}
			}

			console.log("DB 'local' Initialized");

			async.map(collectionNames, function (collectionName, callback) {
				db.collection(collectionName, callback);

			}, function (err, collectionsArray) {
				var ii;

				if (err !== null && err !== undefined) {
					console.log("error: " + err);
					throw err;
				}

				for (ii = 0; ii < collectionsArray.length; ii++) {
					storage.collections[collectionsArray[ii].collectionName] = collectionsArray[ii];
				}

				initCallback(null);
			});
		});
	});
}

function dropDatabase(callback) {
	"use strict";
	/*jslint evil: true */ // necessary evil -- no drop DB call in mongo driver. using a literal, so safe.
	exports.db['eval']('db.dropDatabase()', callback);
}

// for testing convenience, provide capability to drop and re-create the DB
function dropDBHandler(requestContext) {
	"use strict";

	if (requestContext.request.method !== 'DELETE' || !requestContext.path.match(/^\/tcapi\/?$/i)) {
		return false;
	}
	console.log('*** Dropping Database! ***');
	dropDatabase(function (error, result) {
		if (util.checkError(error, requestContext.request, requestContext.response)) {
			console.log(result);

			// re-initialize, re-create DB
			requestContext.storage.init(dbName, function (error) {
				if (error) {
					throw error;
				}
				requestContext.response.statusCode = 204;
				requestContext.response.end();
			});
		}
	});
	return true;
}

function getActorID(actor, callback) {
	"use strict";
	async.series([exports.storeActors([actor], callback),
		exports.findActorMatches([actor], callback)],
		function (error, results) {
			if (error !== null && error !== undefined) {
				callback(error);
			} else if (results.length === 1) {
				callback(null, results[0]._id);
			} else {
				callback(new Error("Failed to find ID for actor: " + JSON.stringify(actor, null, 4)));
			}
		});
}

exports.storeActivities = storeActivities;
exports.storeActors = storeActors;
exports.storeProcessedStatements = storeProcessedStatements;
exports.normalizeStatements = normalizeStatements;
exports.buildStatementQuery = buildStatementQuery;
exports.handleKVPRequest = handleKVPRequest;
exports.getActorId = getActorId;
exports.init = init;
exports.dropDBHandler = dropDBHandler;
exports.findActorMatches = findActorMatches;
exports.getActorID = getActorID;
exports.actorUniqueProps = actorUniqueProps;