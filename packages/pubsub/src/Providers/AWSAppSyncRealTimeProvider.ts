/*
 * Copyright 2017-2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance with
 * the License. A copy of the License is located at
 *
 *     http://aws.amazon.com/apache2.0/
 *
 * or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions
 * and limitations under the License.
 */
import Observable, { ZenObservable } from 'zen-observable-ts';
import { GraphQLError } from 'graphql';
import * as url from 'url';
import { v4 as uuid } from 'uuid';
import { Buffer } from 'buffer';
import { ProviderOptions } from '../types';
import {
	Logger,
	Credentials,
	Signer,
	Hub,
	Constants,
	USER_AGENT_HEADER,
	jitteredExponentialRetry,
	NonRetryableError,
	ICredentials,
} from '@aws-amplify/core';
import Cache from '@aws-amplify/cache';
import Auth, { GRAPHQL_AUTH_MODE } from '@aws-amplify/auth';
import { AbstractPubSubProvider } from './PubSubProvider';
import { CONTROL_MSG } from '../index';

const logger = new Logger('AWSAppSyncRealTimeProvider');

const AMPLIFY_SYMBOL = (
	typeof Symbol !== 'undefined' && typeof Symbol.for === 'function'
		? Symbol.for('amplify_default')
		: '@@amplify_default'
) as Symbol;

const dispatchApiEvent = (event: string, data: any, message: string) => {
	Hub.dispatch('api', { event, data, message }, 'PubSub', AMPLIFY_SYMBOL);
};

const MAX_DELAY_MS = 5000;

const NON_RETRYABLE_CODES = [400, 401, 403];

type ObserverQuery = {
	observer: ZenObservable.SubscriptionObserver<any>;
	query: string;
	variables: object;
	subscriptionState: SUBSCRIPTION_STATUS;
	subscriptionReadyCallback?: Function;
	subscriptionFailedCallback?: Function;
	startAckTimeoutId?: ReturnType<typeof setTimeout>;
};

enum MESSAGE_TYPES {
	/**
	 * Client -> Server message.
	 * This message type is the first message after handshake and this will initialize AWS AppSync RealTime communication
	 */
	GQL_CONNECTION_INIT = 'connection_init',
	/**
	 * Server -> Client message
	 * This message type is in case there is an issue with AWS AppSync RealTime when establishing connection
	 */
	GQL_CONNECTION_ERROR = 'connection_error',
	/**
	 * Server -> Client message.
	 * This message type is for the ack response from AWS AppSync RealTime for GQL_CONNECTION_INIT message
	 */
	GQL_CONNECTION_ACK = 'connection_ack',
	/**
	 * Client -> Server message.
	 * This message type is for register subscriptions with AWS AppSync RealTime
	 */
	GQL_START = 'start',
	/**
	 * Server -> Client message.
	 * This message type is for the ack response from AWS AppSync RealTime for GQL_START message
	 */
	GQL_START_ACK = 'start_ack',
	/**
	 * Server -> Client message.
	 * This message type is for subscription message from AWS AppSync RealTime
	 */
	GQL_DATA = 'data',
	/**
	 * Server -> Client message.
	 * This message type helps the client to know is still receiving messages from AWS AppSync RealTime
	 */
	GQL_CONNECTION_KEEP_ALIVE = 'ka',
	/**
	 * Client -> Server message.
	 * This message type is for unregister subscriptions with AWS AppSync RealTime
	 */
	GQL_STOP = 'stop',
	/**
	 * Server -> Client message.
	 * This message type is for the ack response from AWS AppSync RealTime for GQL_STOP message
	 */
	GQL_COMPLETE = 'complete',
	/**
	 * Server -> Client message.
	 * This message type is for sending error messages from AWS AppSync RealTime to the client
	 */
	GQL_ERROR = 'error', // Server -> Client
}

enum SUBSCRIPTION_STATUS {
	PENDING,
	CONNECTED,
	FAILED,
}

enum SOCKET_STATUS {
	CLOSED,
	READY,
	CONNECTING,
}

const AWS_APPSYNC_REALTIME_HEADERS = {
	accept: 'application/json, text/javascript',
	'content-encoding': 'amz-1.0',
	'content-type': 'application/json; charset=UTF-8',
};

/**
 * Time in milleseconds to wait for GQL_CONNECTION_INIT message
 */
const CONNECTION_INIT_TIMEOUT = 15000;

/**
 * Time in milleseconds to wait for GQL_START_ACK message
 */
const START_ACK_TIMEOUT = 15000;

/**
 * Default Time in milleseconds to wait for GQL_CONNECTION_KEEP_ALIVE message
 */
const DEFAULT_KEEP_ALIVE_TIMEOUT = 5 * 60 * 1000;

const standardDomainPattern =
	/^https:\/\/\w{26}\.appsync\-api\.\w{2}(?:(?:\-\w{2,})+)\-\d\.amazonaws.com\/graphql$/i;

const customDomainPath = '';

type GraphqlAuthModes = keyof typeof GRAPHQL_AUTH_MODE;

export interface AWSAppSyncRealTimeProviderOptions extends ProviderOptions {
	appSyncGraphqlEndpoint?: string;
	authenticationType?: GraphqlAuthModes;
	query?: string;
	variables?: object;
	apiKey?: string;
	region?: string;
	graphql_headers?: () => {} | (() => Promise<{}>);
	additionalHeaders?: { [key: string]: string };
}

type AWSAppSyncRealTimeAuthInput =
	Partial<AWSAppSyncRealTimeProviderOptions> & {
		canonicalUri: string;
		payload: string;
	};

export class AWSAppSyncRealTimeProvider extends AbstractPubSubProvider {
	private awsRealTimeSocket?: WebSocket;
	private socketStatus: SOCKET_STATUS = SOCKET_STATUS.CLOSED;
	private keepAliveTimeoutId?: ReturnType<typeof setTimeout>;
	private keepAliveTimeout = DEFAULT_KEEP_ALIVE_TIMEOUT;
	private subscriptionObserverMap: Map<string, ObserverQuery> = new Map();
	private promiseArray: Array<{ res: Function; rej: Function }> = [];

	getProviderName() {
		return 'AWSAppSyncRealTimeProvider';
	}

	newClient(): Promise<any> {
		throw new Error('Not used here');
	}

	public async publish(_topics: string[] | string, _msg: any, _options?: any) {
		throw new Error('Operation not supported');
	}

	// Check if url matches standard domain pattern
	private isCustomDomain(url: string): boolean {
		return url.match(standardDomainPattern) === null;
	}

	subscribe(
		_topics: string[] | string,
		options?: AWSAppSyncRealTimeProviderOptions
	): Observable<any> {
		const appSyncGraphqlEndpoint = options?.appSyncGraphqlEndpoint;

		return new Observable(observer => {
			if (!options || !appSyncGraphqlEndpoint) {
				observer.error({
					errors: [
						{
							...new GraphQLError(
								`Subscribe only available for AWS AppSync endpoint`
							),
						},
					],
				});
				observer.complete();
			} else {
				const subscriptionId = uuid();
				this._startSubscriptionWithAWSAppSyncRealTime({
					options,
					observer,
					subscriptionId,
				}).catch<any>(err => {
					observer.error({
						errors: [
							{
								...new GraphQLError(
									`${CONTROL_MSG.REALTIME_SUBSCRIPTION_INIT_ERROR}: ${err}`
								),
							},
						],
					});
					observer.complete();
				});

				return async () => {
					// Cleanup after unsubscribing or observer.complete was called after _startSubscriptionWithAWSAppSyncRealTime
					try {
						// Waiting that subscription has been connected before trying to unsubscribe
						await this._waitForSubscriptionToBeConnected(subscriptionId);

						const { subscriptionState } =
							this.subscriptionObserverMap.get(subscriptionId) || {};

						if (!subscriptionState) {
							// subscription already unsubscribed
							return;
						}

						if (subscriptionState === SUBSCRIPTION_STATUS.CONNECTED) {
							this._sendUnsubscriptionMessage(subscriptionId);
						} else {
							throw new Error('Subscription never connected');
						}
					} catch (err) {
						logger.debug(`Error while unsubscribing ${err}`);
					} finally {
						this._removeSubscriptionObserver(subscriptionId);
					}
				};
			}
		});
	}

	protected get isSSLEnabled() {
		return !this.options
			.aws_appsync_dangerously_connect_to_http_endpoint_for_testing;
	}

	private async _startSubscriptionWithAWSAppSyncRealTime({
		options,
		observer,
		subscriptionId,
	}: {
		options: AWSAppSyncRealTimeProviderOptions;
		observer: ZenObservable.SubscriptionObserver<any>;
		subscriptionId: string;
	}) {
		const {
			appSyncGraphqlEndpoint,
			authenticationType,
			query,
			variables,
			apiKey,
			region,
			graphql_headers = () => ({}),
			additionalHeaders = {},
		} = options;

		const subscriptionState: SUBSCRIPTION_STATUS = SUBSCRIPTION_STATUS.PENDING;
		const data = {
			query,
			variables,
		};
		// Having a subscription id map will make it simple to forward messages received
		this.subscriptionObserverMap.set(subscriptionId, {
			observer,
			query: query ?? '',
			variables: variables ?? {},
			subscriptionState,
			startAckTimeoutId: undefined,
		});

		// Preparing payload for subscription message

		const dataString = JSON.stringify(data);
		const headerObj = {
			...(await this._awsRealTimeHeaderBasedAuth({
				apiKey,
				appSyncGraphqlEndpoint,
				authenticationType,
				payload: dataString,
				canonicalUri: '',
				region,
				additionalHeaders,
			})),
			...(await graphql_headers()),
			...additionalHeaders,
			[USER_AGENT_HEADER]: Constants.userAgent,
		};

		const subscriptionMessage = {
			id: subscriptionId,
			payload: {
				data: dataString,
				extensions: {
					authorization: {
						...headerObj,
					},
				},
			},
			type: MESSAGE_TYPES.GQL_START,
		};

		const stringToAWSRealTime = JSON.stringify(subscriptionMessage);

		try {
			await this._initializeWebSocketConnection({
				apiKey,
				appSyncGraphqlEndpoint,
				authenticationType,
				region,
				additionalHeaders,
			});
		} catch (err) {
			logger.debug({ err });
			const message = err['message'] ?? '';
			observer.error({
				errors: [
					{
						...new GraphQLError(`${CONTROL_MSG.CONNECTION_FAILED}: ${message}`),
					},
				],
			});
			observer.complete();
			const { subscriptionFailedCallback } =
				this.subscriptionObserverMap.get(subscriptionId) || {};

			// Notify concurrent unsubscription
			if (typeof subscriptionFailedCallback === 'function') {
				subscriptionFailedCallback();
			}
			return;
		}

		// Potential race condition can occur when unsubscribe is called during _initializeWebSocketConnection.
		// E.g.unsubscribe gets invoked prior to finishing WebSocket handshake or START_ACK.
		// Both subscriptionFailedCallback and subscriptionReadyCallback are used to synchronized this.

		const { subscriptionFailedCallback, subscriptionReadyCallback } =
			this.subscriptionObserverMap.get(subscriptionId) ?? {};

		// This must be done before sending the message in order to be listening immediately
		this.subscriptionObserverMap.set(subscriptionId, {
			observer,
			subscriptionState,
			query: query ?? '',
			variables: variables ?? {},
			subscriptionReadyCallback,
			subscriptionFailedCallback,
			startAckTimeoutId: setTimeout(() => {
				this._timeoutStartSubscriptionAck.call(this, subscriptionId);
			}, START_ACK_TIMEOUT),
		});
		if (this.awsRealTimeSocket) {
			this.awsRealTimeSocket.send(stringToAWSRealTime);
		}
	}

	// Waiting that subscription has been connected before trying to unsubscribe
	private async _waitForSubscriptionToBeConnected(subscriptionId: string) {
		const subscriptionObserver =
			this.subscriptionObserverMap.get(subscriptionId);
		if (subscriptionObserver) {
			const { subscriptionState } = subscriptionObserver;
			// This in case unsubscribe is invoked before sending start subscription message
			if (subscriptionState === SUBSCRIPTION_STATUS.PENDING) {
				return new Promise((res, rej) => {
					const { observer, subscriptionState, variables, query } =
						subscriptionObserver;
					this.subscriptionObserverMap.set(subscriptionId, {
						observer,
						subscriptionState,
						variables,
						query,
						subscriptionReadyCallback: res,
						subscriptionFailedCallback: rej,
					});
				});
			}
		}
	}

	private _sendUnsubscriptionMessage(subscriptionId: string) {
		try {
			if (
				this.awsRealTimeSocket &&
				this.awsRealTimeSocket.readyState === WebSocket.OPEN &&
				this.socketStatus === SOCKET_STATUS.READY
			) {
				// Preparing unsubscribe message to stop receiving messages for that subscription
				const unsubscribeMessage = {
					id: subscriptionId,
					type: MESSAGE_TYPES.GQL_STOP,
				};
				const stringToAWSRealTime = JSON.stringify(unsubscribeMessage);
				this.awsRealTimeSocket.send(stringToAWSRealTime);
			}
		} catch (err) {
			// If GQL_STOP is not sent because of disconnection issue, then there is nothing the client can do
			logger.debug({ err });
		}
	}

	private _removeSubscriptionObserver(subscriptionId: string) {
		this.subscriptionObserverMap.delete(subscriptionId);

		// Verifying 1000ms after removing subscription in case there are new subscription unmount/mount
		setTimeout(this._closeSocketIfRequired.bind(this), 1000);
	}

	private _closeSocketIfRequired() {
		if (this.subscriptionObserverMap.size > 0) {
			// Active subscriptions on the WebSocket
			return;
		}

		if (!this.awsRealTimeSocket) {
			this.socketStatus = SOCKET_STATUS.CLOSED;
			return;
		}
		if (this.awsRealTimeSocket.bufferedAmount > 0) {
			// Still data on the WebSocket
			setTimeout(this._closeSocketIfRequired.bind(this), 1000);
		} else {
			logger.debug('closing WebSocket...');
			if (this.keepAliveTimeoutId) clearTimeout(this.keepAliveTimeoutId);
			const tempSocket = this.awsRealTimeSocket;
			// Cleaning callbacks to avoid race condition, socket still exists
			tempSocket.onclose = null;
			tempSocket.onerror = null;
			tempSocket.close(1000);
			this.awsRealTimeSocket = undefined;
			this.socketStatus = SOCKET_STATUS.CLOSED;
		}
	}

	private _handleIncomingSubscriptionMessage(message: MessageEvent) {
		logger.debug(
			`subscription message from AWS AppSync RealTime: ${message.data}`
		);
		const { id = '', payload, type } = JSON.parse(message.data);
		const {
			observer = null,
			query = '',
			variables = {},
			startAckTimeoutId,
			subscriptionReadyCallback,
			subscriptionFailedCallback,
		} = this.subscriptionObserverMap.get(id) || {};

		logger.debug({ id, observer, query, variables });

		if (type === MESSAGE_TYPES.GQL_DATA && payload && payload.data) {
			if (observer) {
				observer.next(payload);
			} else {
				logger.debug(`observer not found for id: ${id}`);
			}
			return;
		}

		if (type === MESSAGE_TYPES.GQL_START_ACK) {
			logger.debug(
				`subscription ready for ${JSON.stringify({ query, variables })}`
			);
			if (typeof subscriptionReadyCallback === 'function') {
				subscriptionReadyCallback();
			}
			if (startAckTimeoutId) clearTimeout(startAckTimeoutId);
			dispatchApiEvent(
				CONTROL_MSG.SUBSCRIPTION_ACK,
				{ query, variables },
				'Connection established for subscription'
			);
			const subscriptionState = SUBSCRIPTION_STATUS.CONNECTED;
			if (observer) {
				this.subscriptionObserverMap.set(id, {
					observer,
					query,
					variables,
					startAckTimeoutId: undefined,
					subscriptionState,
					subscriptionReadyCallback,
					subscriptionFailedCallback,
				});
			}

			// TODO: emit event on hub but it requires to store the id first
			return;
		}

		if (type === MESSAGE_TYPES.GQL_CONNECTION_KEEP_ALIVE) {
			if (this.keepAliveTimeoutId) clearTimeout(this.keepAliveTimeoutId);
			this.keepAliveTimeoutId = setTimeout(
				this._errorDisconnect.bind(this, CONTROL_MSG.TIMEOUT_DISCONNECT),
				this.keepAliveTimeout
			);
			return;
		}

		if (type === MESSAGE_TYPES.GQL_ERROR) {
			const subscriptionState = SUBSCRIPTION_STATUS.FAILED;
			if (observer) {
				this.subscriptionObserverMap.set(id, {
					observer,
					query,
					variables,
					startAckTimeoutId,
					subscriptionReadyCallback,
					subscriptionFailedCallback,
					subscriptionState,
				});

				observer.error({
					errors: [
						{
							...new GraphQLError(
								`${CONTROL_MSG.CONNECTION_FAILED}: ${JSON.stringify(payload)}`
							),
						},
					],
				});
				if (startAckTimeoutId) clearTimeout(startAckTimeoutId);

				observer.complete();
				if (typeof subscriptionFailedCallback === 'function') {
					subscriptionFailedCallback();
				}
			}
		}
	}

	private _errorDisconnect(msg: string) {
		logger.debug(`Disconnect error: ${msg}`);
		this.subscriptionObserverMap.forEach(({ observer }) => {
			if (observer && !observer.closed) {
				observer.error({
					errors: [{ ...new GraphQLError(msg) }],
				});
			}
		});
		this.subscriptionObserverMap.clear();
		if (this.awsRealTimeSocket) {
			this.awsRealTimeSocket.close();
		}

		this.socketStatus = SOCKET_STATUS.CLOSED;
	}

	private _timeoutStartSubscriptionAck(subscriptionId: string) {
		const subscriptionObserver =
			this.subscriptionObserverMap.get(subscriptionId);
		if (subscriptionObserver) {
			const { observer, query, variables } = subscriptionObserver;
			if (!observer) {
				return;
			}
			this.subscriptionObserverMap.set(subscriptionId, {
				observer,
				query,
				variables,
				subscriptionState: SUBSCRIPTION_STATUS.FAILED,
			});

			if (observer && !observer.closed) {
				observer.error({
					errors: [
						{
							...new GraphQLError(
								`Subscription timeout ${JSON.stringify({
									query,
									variables,
								})}`
							),
						},
					],
				});
				// Cleanup will be automatically executed
				observer.complete();
			}
			logger.debug(
				'timeoutStartSubscription',
				JSON.stringify({ query, variables })
			);
		}
	}

	private _initializeWebSocketConnection({
		appSyncGraphqlEndpoint,
		authenticationType,
		apiKey,
		region,
		additionalHeaders,
	}: AWSAppSyncRealTimeProviderOptions) {
		if (this.socketStatus === SOCKET_STATUS.READY) {
			return;
		}
		return new Promise(async (res, rej) => {
			this.promiseArray.push({ res, rej });

			if (this.socketStatus === SOCKET_STATUS.CLOSED) {
				try {
					this.socketStatus = SOCKET_STATUS.CONNECTING;

					const payloadString = '{}';
					const headerString = JSON.stringify(
						await this._awsRealTimeHeaderBasedAuth({
							authenticationType,
							payload: payloadString,
							canonicalUri: '/connect',
							apiKey,
							appSyncGraphqlEndpoint,
							region,
							additionalHeaders,
						})
					);
					const headerQs = Buffer.from(headerString).toString('base64');

					const payloadQs = Buffer.from(payloadString).toString('base64');

					let discoverableEndpoint = appSyncGraphqlEndpoint ?? '';

					if (this.isCustomDomain(discoverableEndpoint)) {
						discoverableEndpoint =
							discoverableEndpoint.concat(customDomainPath);
					} else {
						discoverableEndpoint = discoverableEndpoint
							.replace('appsync-api', 'appsync-realtime-api')
							.replace('gogi-beta', 'grt-beta');
					}

					// Creating websocket url with required query strings
					const protocol = this.isSSLEnabled ? 'wss://' : 'ws://';
					discoverableEndpoint = discoverableEndpoint
						.replace('https://', protocol)
						.replace('http://', protocol);

					const awsRealTimeUrl = `${discoverableEndpoint}?header=${headerQs}&payload=${payloadQs}`;

					await this._initializeRetryableHandshake(awsRealTimeUrl);

					this.promiseArray.forEach(({ res }) => {
						logger.debug('Notifying connection successful');
						res();
					});
					this.socketStatus = SOCKET_STATUS.READY;
					this.promiseArray = [];
				} catch (err) {
					this.promiseArray.forEach(({ rej }) => rej(err));
					this.promiseArray = [];
					if (
						this.awsRealTimeSocket &&
						this.awsRealTimeSocket.readyState === WebSocket.OPEN
					) {
						this.awsRealTimeSocket.close(3001);
					}
					this.awsRealTimeSocket = undefined;
					this.socketStatus = SOCKET_STATUS.CLOSED;
				}
			}
		});
	}

	private async _initializeRetryableHandshake(awsRealTimeUrl: string) {
		logger.debug(`Initializaling retryable Handshake`);
		await jitteredExponentialRetry(
			this._initializeHandshake.bind(this),
			[awsRealTimeUrl],
			MAX_DELAY_MS
		);
	}

	private async _initializeHandshake(awsRealTimeUrl: string) {
		logger.debug(`Initializing handshake ${awsRealTimeUrl}`);
		// Because connecting the socket is async, is waiting until connection is open
		// Step 1: connect websocket
		try {
			await (() => {
				return new Promise<void>((res, rej) => {
					const newSocket = new WebSocket(awsRealTimeUrl, 'graphql-ws');
					newSocket.onerror = () => {
						logger.debug(`WebSocket connection error`);
					};
					newSocket.onclose = () => {
						rej(new Error('Connection handshake error'));
					};
					newSocket.onopen = () => {
						this.awsRealTimeSocket = newSocket;
						return res();
					};
				});
			})();

			// Step 2: wait for ack from AWS AppSyncReaTime after sending init
			await (() => {
				return new Promise((res, rej) => {
					if (this.awsRealTimeSocket) {
						let ackOk = false;
						this.awsRealTimeSocket.onerror = error => {
							logger.debug(`WebSocket error ${JSON.stringify(error)}`);
						};
						this.awsRealTimeSocket.onclose = event => {
							logger.debug(`WebSocket closed ${event.reason}`);
							rej(new Error(JSON.stringify(event)));
						};

						this.awsRealTimeSocket.onmessage = (message: MessageEvent) => {
							logger.debug(
								`subscription message from AWS AppSyncRealTime: ${message.data} `
							);
							const data = JSON.parse(message.data);
							const {
								type,
								payload: {
									connectionTimeoutMs = DEFAULT_KEEP_ALIVE_TIMEOUT,
								} = {},
							} = data;
							if (type === MESSAGE_TYPES.GQL_CONNECTION_ACK) {
								ackOk = true;
								if (this.awsRealTimeSocket) {
									this.keepAliveTimeout = connectionTimeoutMs;
									this.awsRealTimeSocket.onmessage =
										this._handleIncomingSubscriptionMessage.bind(this);
									this.awsRealTimeSocket.onerror = err => {
										logger.debug(err);
										this._errorDisconnect(CONTROL_MSG.CONNECTION_CLOSED);
									};
									this.awsRealTimeSocket.onclose = event => {
										logger.debug(`WebSocket closed ${event.reason}`);
										this._errorDisconnect(CONTROL_MSG.CONNECTION_CLOSED);
									};
								}
								res('Cool, connected to AWS AppSyncRealTime');
								return;
							}

							if (type === MESSAGE_TYPES.GQL_CONNECTION_ERROR) {
								const {
									payload: {
										errors: [{ errorType = '', errorCode = 0 } = {}] = [],
									} = {},
								} = data;

								rej({ errorType, errorCode });
							}
						};

						const gqlInit = {
							type: MESSAGE_TYPES.GQL_CONNECTION_INIT,
						};
						this.awsRealTimeSocket.send(JSON.stringify(gqlInit));

						setTimeout(checkAckOk.bind(this, ackOk), CONNECTION_INIT_TIMEOUT);
					}

					function checkAckOk(ackOk: boolean) {
						if (!ackOk) {
							rej(
								new Error(
									`Connection timeout: ack from AWSRealTime was not received on ${CONNECTION_INIT_TIMEOUT} ms`
								)
							);
						}
					}
				});
			})();
		} catch (err) {
			const { errorType, errorCode } = err as {
				errorType: string;
				errorCode: number;
			};

			if (NON_RETRYABLE_CODES.includes(errorCode)) {
				throw new NonRetryableError(errorType);
			} else if (errorType) {
				throw new Error(errorType);
			} else {
				throw err;
			}
		}
	}

	private async _awsRealTimeHeaderBasedAuth({
		authenticationType,
		payload,
		canonicalUri,
		appSyncGraphqlEndpoint,
		apiKey,
		region,
		additionalHeaders,
	}: AWSAppSyncRealTimeProviderOptions): Promise<any> {
		const headerHandler: {
			[key in GraphqlAuthModes]: (AWSAppSyncRealTimeAuthInput) => {};
		} = {
			API_KEY: this._awsRealTimeApiKeyHeader.bind(this),
			AWS_IAM: this._awsRealTimeIAMHeader.bind(this),
			OPENID_CONNECT: this._awsRealTimeOPENIDHeader.bind(this),
			AMAZON_COGNITO_USER_POOLS: this._awsRealTimeCUPHeader.bind(this),
			AWS_LAMBDA: this._customAuthHeader,
		};

		if (!authenticationType || !headerHandler[authenticationType]) {
			logger.debug(`Authentication type ${authenticationType} not supported`);
			return '';
		} else {
			const handler = headerHandler[authenticationType];

			const { host } = url.parse(appSyncGraphqlEndpoint ?? '');

			const result = await handler({
				payload,
				canonicalUri,
				appSyncGraphqlEndpoint,
				apiKey,
				region,
				host,
				additionalHeaders,
			});

			return result;
		}
	}

	private async _awsRealTimeCUPHeader({ host }: AWSAppSyncRealTimeAuthInput) {
		const session = await Auth.currentSession();
		return {
			Authorization: session.getAccessToken().getJwtToken(),
			host,
		};
	}

	private async _awsRealTimeOPENIDHeader({
		host,
	}: AWSAppSyncRealTimeAuthInput) {
		let token;
		// backwards compatibility
		const federatedInfo = await Cache.getItem('federatedInfo');
		if (federatedInfo) {
			token = federatedInfo.token;
		} else {
			const currentUser = await Auth.currentAuthenticatedUser();
			if (currentUser) {
				token = currentUser.token;
			}
		}
		if (!token) {
			throw new Error('No federated jwt');
		}
		return {
			Authorization: token,
			host,
		};
	}

	private async _awsRealTimeApiKeyHeader({
		apiKey,
		host,
	}: AWSAppSyncRealTimeAuthInput) {
		const dt = new Date();
		const dtStr = dt.toISOString().replace(/[:\-]|\.\d{3}/g, '');

		return {
			host,
			'x-amz-date': dtStr,
			'x-api-key': apiKey,
		};
	}

	private async _awsRealTimeIAMHeader({
		payload,
		canonicalUri,
		appSyncGraphqlEndpoint,
		region,
	}: AWSAppSyncRealTimeAuthInput) {
		const endpointInfo = {
			region,
			service: 'appsync',
		};

		const credentialsOK = await this._ensureCredentials();
		if (!credentialsOK) {
			throw new Error('No credentials');
		}
		const creds = await Credentials.get().then((credentials: any) => {
			const { secretAccessKey, accessKeyId, sessionToken } =
				credentials as ICredentials;

			return {
				secret_key: secretAccessKey,
				access_key: accessKeyId,
				session_token: sessionToken,
			};
		});

		const request = {
			url: `${appSyncGraphqlEndpoint}${canonicalUri}`,
			data: payload,
			method: 'POST',
			headers: { ...AWS_APPSYNC_REALTIME_HEADERS },
		};

		const signed_params = Signer.sign(request, creds, endpointInfo);
		return signed_params.headers;
	}

	private _customAuthHeader({
		host,
		additionalHeaders,
	}: AWSAppSyncRealTimeAuthInput) {
		if (!additionalHeaders || !additionalHeaders['Authorization']) {
			throw new Error('No auth token specified');
		}

		return {
			Authorization: additionalHeaders.Authorization,
			host,
		};
	}

	/**
	 * @private
	 */
	_ensureCredentials() {
		return Credentials.get()
			.then((credentials: any) => {
				if (!credentials) return false;
				const cred = Credentials.shear(credentials);
				logger.debug('set credentials for AWSAppSyncRealTimeProvider', cred);

				return true;
			})
			.catch((err: any) => {
				logger.warn('ensure credentials error', err);
				return false;
			});
	}
}
