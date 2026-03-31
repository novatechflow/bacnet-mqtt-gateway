const { createApp } = Vue;

const SessionVault = (() => {
    const ACCESS_TOKEN_KEY = 'bacnet_gateway_access_token';
    const REFRESH_TOKEN_KEY = 'bacnet_gateway_refresh_token';
    const LEGACY_TOKEN_KEY = 'bacnet_gateway_token';
    const KEY_MATERIAL = 'bacnet-gw-ui-key';
    const PLAINTEXT_PREFIX = 'plain:';

    function hasWebCrypto() {
        return typeof crypto !== 'undefined' &&
            crypto.subtle &&
            typeof crypto.subtle.importKey === 'function';
    }

    async function getKey() {
        const enc = new TextEncoder();
        return crypto.subtle.importKey(
            'raw',
            enc.encode(KEY_MATERIAL),
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );
    }

    function bufToBase64(buf) {
        return btoa(String.fromCharCode(...new Uint8Array(buf)));
    }

    function base64ToBuf(b64) {
        const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
        return bytes.buffer;
    }

    async function encryptToken(token) {
        if (!hasWebCrypto()) {
            return `${PLAINTEXT_PREFIX}${token}`;
        }
        const key = await getKey();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const enc = new TextEncoder();
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(token));
        return `${bufToBase64(iv)}.${bufToBase64(encrypted)}`;
    }

    async function decryptToken(payload) {
        if (!payload) {
            return null;
        }
        try {
            if (payload.startsWith(PLAINTEXT_PREFIX)) {
                return payload.slice(PLAINTEXT_PREFIX.length);
            }
            if (!hasWebCrypto()) {
                return null;
            }
            const [ivB64, dataB64] = payload.split('.');
            const iv = new Uint8Array(base64ToBuf(ivB64));
            const data = base64ToBuf(dataB64);
            const key = await getKey();
            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
            return new TextDecoder().decode(decrypted);
        } catch (err) {
            console.error('Failed to decrypt token', err);
            return null;
        }
    }

    return {
        async saveSession(accessToken, refreshToken) {
            const encryptedAccessToken = await encryptToken(accessToken);
            localStorage.setItem(ACCESS_TOKEN_KEY, encryptedAccessToken);
            if (refreshToken) {
                const encryptedRefreshToken = await encryptToken(refreshToken);
                localStorage.setItem(REFRESH_TOKEN_KEY, encryptedRefreshToken);
            }
        },
        async loadSession() {
            const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
            if (legacyToken) {
                localStorage.setItem(ACCESS_TOKEN_KEY, legacyToken);
                localStorage.removeItem(LEGACY_TOKEN_KEY);
            }
            const accessToken = await decryptToken(localStorage.getItem(ACCESS_TOKEN_KEY) || '');
            const refreshToken = await decryptToken(localStorage.getItem(REFRESH_TOKEN_KEY) || '');
            return { accessToken, refreshToken };
        },
        clear() {
            localStorage.removeItem(ACCESS_TOKEN_KEY);
            localStorage.removeItem(REFRESH_TOKEN_KEY);
            localStorage.removeItem(LEGACY_TOKEN_KEY);
        }
    };
})();

function parseJwt(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map((char) => {
            return `%${(`00${char.charCodeAt(0).toString(16)}`).slice(-2)}`;
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (_err) {
        return null;
    }
}

function extractErrorMessage(error, fallback) {
    return (error.response && error.response.data && error.response.data.message) || error.message || fallback;
}

const Spinner = {
    template: '#spinner-template'
};

const WhoisPanel = {
    template: '#whois-template',
    data() {
        return {
            loading: false,
            devices: [],
            cancelTokenSource: null,
            error: null
        };
    },
    methods: {
        async startScan() {
            if (this.loading) {
                return;
            }
            this.loading = true;
            this.error = null;
            this.devices = [];
            this.cancelTokenSource = axios.CancelToken.source();
            try {
                const response = await axios.put('/api/bacnet/scan', {}, { cancelToken: this.cancelTokenSource.token });
                this.devices = response.data || [];
            } catch (error) {
                if (axios.isCancel(error)) {
                    this.error = 'Scan stopped.';
                } else {
                    this.error = extractErrorMessage(error, 'Failed to scan BACnet network');
                }
            } finally {
                this.loading = false;
                this.cancelTokenSource = null;
            }
        },
        stopScan() {
            if (this.cancelTokenSource) {
                this.cancelTokenSource.cancel('Scan stopped by user.');
            }
        }
    }
};

const ObjectWriteForm = {
    template: '#object-write-form-template',
    components: { Spinner },
    props: {
        deviceId: { type: [String, Number], required: true },
        objectType: { type: Number, required: true },
        objectInstance: { type: Number, required: true },
        initialObjectName: { type: String, default: '' }
    },
    emits: ['close', 'success'],
    data() {
        return {
            loading: false,
            valueToWrite: '',
            propertyId: 85,
            priority: null,
            bacnetApplicationTag: null,
            status: null,
            message: null,
            commonProperties: [
                { text: 'Present Value (85)', value: 85 },
                { text: 'Object Name (77)', value: 77 },
                { text: 'Description (28)', value: 28 },
                { text: 'Reliability (103)', value: 103 },
                { text: 'Out Of Service (81)', value: 81 }
            ],
            commonAppTags: [
                { text: 'Auto Detect', value: null },
                { text: 'NULL (0)', value: 0 },
                { text: 'BOOLEAN (1)', value: 1 },
                { text: 'UNSIGNED INT (2)', value: 2 },
                { text: 'SIGNED INT (3)', value: 3 },
                { text: 'REAL (4)', value: 4 },
                { text: 'DOUBLE (5)', value: 5 },
                { text: 'CHARACTER STRING (7)', value: 7 },
                { text: 'ENUMERATED (9)', value: 9 }
            ]
        };
    },
    methods: {
        async submitWrite() {
            this.loading = true;
            this.status = null;
            this.message = null;

            const payload = {
                deviceId: this.deviceId,
                objectType: this.objectType,
                objectInstance: this.objectInstance,
                propertyId: Number(this.propertyId),
                value: this.valueToWrite
            };

            if (this.priority !== null && this.priority !== '') {
                payload.priority = Number(this.priority);
            }
            if (this.bacnetApplicationTag !== null && this.bacnetApplicationTag !== '') {
                payload.bacnetApplicationTag = Number(this.bacnetApplicationTag);
            }

            try {
                const response = await axios.put('/api/bacnet/write', payload);
                this.status = 'success';
                this.message = response.data.message || 'Write successful';
                this.$emit('success');
            } catch (error) {
                this.status = 'error';
                this.message = extractErrorMessage(error, 'Failed to perform write operation');
            } finally {
                this.loading = false;
            }
        }
    }
};

const DeviceScan = {
    template: '#device-scan-template',
    components: { Spinner, ObjectWriteForm },
    props: {
        canWrite: { type: Boolean, default: false }
    },
    data() {
        return {
            loading: false,
            deviceId: '',
            address: '',
            objects: [],
            error: null,
            selectedObject: null
        };
    },
    methods: {
        async scanDevice() {
            this.loading = true;
            this.error = null;
            try {
                const response = await axios.put(`/api/bacnet/${this.deviceId}/objects`, {
                    deviceId: this.deviceId,
                    address: this.address
                });
                this.objects = response.data || [];
            } catch (error) {
                this.objects = [];
                this.error = extractErrorMessage(error, 'Failed to read BACnet device objects');
            } finally {
                this.loading = false;
            }
        },
        openWriteForm(object) {
            this.selectedObject = {
                objectType: object.objectId.type,
                objectInstance: object.objectId.instance,
                initialObjectName: object.name || '',
                deviceId: this.deviceId
            };
        },
        closeWriteForm() {
            this.selectedObject = null;
        }
    }
};

const ConfiguredDevices = {
    template: '#configured-devices-template',
    components: { Spinner },
    data() {
        return {
            loading: false,
            devices: [],
            error: null
        };
    },
    methods: {
        async load() {
            this.loading = true;
            this.error = null;
            try {
                const response = await axios.get('/api/bacnet/configured');
                this.devices = response.data || [];
            } catch (error) {
                this.error = extractErrorMessage(error, 'Failed to load configured devices');
            } finally {
                this.loading = false;
            }
        }
    },
    mounted() {
        this.load();
    }
};

const RuntimeDevices = {
    template: '#runtime-devices-template',
    components: { Spinner },
    data() {
        return {
            loading: false,
            devices: [],
            error: null
        };
    },
    methods: {
        formatTimestamp(value) {
            if (!value) {
                return '-';
            }
            return new Date(value).toLocaleString();
        },
        async load() {
            this.loading = true;
            this.error = null;
            try {
                const response = await axios.get('/api/bacnet/runtime');
                this.devices = response.data || [];
            } catch (error) {
                this.error = extractErrorMessage(error, 'Failed to load runtime device state');
            } finally {
                this.loading = false;
            }
        }
    },
    mounted() {
        this.load();
    }
};

createApp({
    components: {
        Spinner,
        WhoisPanel,
        DeviceScan,
        ConfiguredDevices,
        RuntimeDevices
    },
    data() {
        return {
            state: 'whois',
            tokenValid: false,
            loginLoading: false,
            loginError: null,
            loginForm: {
                username: '',
                password: ''
            },
            currentUser: {
                username: '',
                role: ''
            },
            health: {
                status: 'unknown',
                mqtt: { connected: false },
                bacnet: { configuredDevices: 0 },
                runtime: { openCircuits: 0, staleObjects: 0, degradedDevices: 0 }
            },
            changePasswordModal: false,
            changeForm: {
                oldPassword: '',
                newPassword: ''
            },
            changeError: null,
            changeSuccess: null,
            refreshInFlight: null
        };
    },
    computed: {
        canWrite() {
            return this.currentUser.role === 'admin';
        }
    },
    methods: {
        async initAuth() {
            const session = await SessionVault.loadSession();
            if (!session.accessToken) {
                this.tokenValid = false;
                return;
            }

            const payload = parseJwt(session.accessToken);
            if (!payload || !payload.exp || payload.exp * 1000 < Date.now()) {
                if (session.refreshToken) {
                    try {
                        await this.refreshSession(session.refreshToken);
                        return;
                    } catch (_err) {
                    }
                }
                SessionVault.clear();
                this.tokenValid = false;
                return;
            }

            this.setAuth(session.accessToken, payload);
        },
        setAuth(token, payload) {
            axios.defaults.headers.common.Authorization = `Bearer ${token}`;
            this.tokenValid = true;
            this.currentUser = {
                username: payload.username || '',
                role: payload.role || ''
            };
        },
        async refreshSession(explicitRefreshToken) {
            if (this.refreshInFlight) {
                return this.refreshInFlight;
            }

            this.refreshInFlight = (async () => {
                const session = await SessionVault.loadSession();
                const refreshToken = explicitRefreshToken || session.refreshToken;
                if (!refreshToken) {
                    throw new Error('Missing refresh token');
                }

                const response = await axios.create().post('/auth/refresh', { refreshToken });
                const accessToken = response.data.token;
                const nextRefreshToken = response.data.refreshToken || refreshToken;
                const payload = parseJwt(accessToken);
                if (!payload) {
                    throw new Error('Invalid token received');
                }

                await SessionVault.saveSession(accessToken, nextRefreshToken);
                this.setAuth(accessToken, payload);
                return accessToken;
            })();

            try {
                return await this.refreshInFlight;
            } finally {
                this.refreshInFlight = null;
            }
        },
        async login() {
            this.loginLoading = true;
            this.loginError = null;

            try {
                const response = await axios.post('/auth/login', {
                    username: this.loginForm.username,
                    password: this.loginForm.password
                });
                const token = response.data.token;
                const payload = parseJwt(token);
                if (!payload) {
                    throw new Error('Invalid token received');
                }

                await SessionVault.saveSession(token, response.data.refreshToken);
                this.setAuth(token, payload);
                this.loginForm.password = '';
            } catch (error) {
                this.loginError = extractErrorMessage(error, 'Login failed');
                SessionVault.clear();
            } finally {
                this.loginLoading = false;
            }
        },
        logout() {
            SessionVault.clear();
            delete axios.defaults.headers.common.Authorization;
            this.tokenValid = false;
            this.currentUser = { username: '', role: '' };
            this.state = 'whois';
        },
        showView(name) {
            this.state = name;
        },
        async loadHealth() {
            try {
                const response = await axios.get('/health');
                const data = response.data || {};
                this.health = {
                    status: data.status || 'unknown',
                    mqtt: data.mqtt || { connected: false },
                    bacnet: data.bacnet || { configuredDevices: 0 },
                    runtime: data.runtime || { openCircuits: 0, staleObjects: 0, degradedDevices: 0 }
                };
            } catch (_error) {
                this.health = {
                    status: 'degraded',
                    mqtt: { connected: false },
                    bacnet: { configuredDevices: 0 },
                    runtime: { openCircuits: 0, staleObjects: 0, degradedDevices: 0 }
                };
            }
        },
        openChangePassword() {
            this.changePasswordModal = true;
            this.changeError = null;
            this.changeSuccess = null;
            this.changeForm = { oldPassword: '', newPassword: '' };
        },
        closeChangePassword() {
            this.changePasswordModal = false;
            this.changeError = null;
            this.changeSuccess = null;
        },
        async submitChangePassword() {
            this.changeError = null;
            this.changeSuccess = null;
            try {
                await axios.post('/auth/change-password', {
                    oldPassword: this.changeForm.oldPassword,
                    newPassword: this.changeForm.newPassword
                });
                this.changeSuccess = 'Password updated. Please log in again.';
                window.setTimeout(() => {
                    this.closeChangePassword();
                    this.logout();
                }, 900);
            } catch (error) {
                this.changeError = extractErrorMessage(error, 'Failed to change password');
            }
        }
    },
    async mounted() {
        axios.interceptors.response.use(
            (response) => response,
            async (error) => {
                const originalRequest = error.config || {};
                const requestUrl = originalRequest.url || '';

                if (
                    error.response &&
                    error.response.status === 401 &&
                    !originalRequest._retry &&
                    !requestUrl.includes('/auth/login') &&
                    !requestUrl.includes('/auth/refresh')
                ) {
                    originalRequest._retry = true;
                    try {
                        const token = await this.refreshSession();
                        originalRequest.headers = originalRequest.headers || {};
                        originalRequest.headers.Authorization = `Bearer ${token}`;
                        return axios(originalRequest);
                    } catch (_refreshError) {
                        this.logout();
                    }
                } else if (error.response && error.response.status === 401) {
                    this.logout();
                }

                return Promise.reject(error);
            }
        );

        await this.initAuth();
        await this.loadHealth();
        window.setInterval(() => this.loadHealth(), 15000);
    }
}).mount('#app');
