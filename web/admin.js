Vue.component('spinner', {
    template: '#spinner'
});

// simple token vault with AES-GCM using a static key (better than plaintext storage)
const TokenVault = (() => {
    const STORAGE_KEY = 'bacnet_gateway_token';
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
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        return bytes.buffer;
    }

    async function encryptToken(token) {
        if (!hasWebCrypto()) {
            return `${PLAINTEXT_PREFIX}${token}`;
        }
        const key = await getKey();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const enc = new TextEncoder();
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            enc.encode(token)
        );
        return `${bufToBase64(iv)}.${bufToBase64(encrypted)}`;
    }

    async function decryptToken(payload) {
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
            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                key,
                data
            );
            return new TextDecoder().decode(decrypted);
        } catch (err) {
            console.error('Failed to decrypt token', err);
            return null;
        }
    }

    return {
        async save(token) {
            const encrypted = await encryptToken(token);
            localStorage.setItem(STORAGE_KEY, encrypted);
        },
        async load() {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (!stored) return null;
            return decryptToken(stored);
        },
        clear() {
            localStorage.removeItem(STORAGE_KEY);
        }
    };
})();

function parseJwt(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (e) {
        return null;
    }
}

Vue.component('whois', {
    data() {
        return {
            loading: false,
            devices: null,
            cancelTokenSource: null 
        }
    },
    methods: {
        whois() {
            if (this.loading && this.cancelTokenSource) {
                return;
            }

            this.loading = true;
            this.devices = null; 
            this.cancelTokenSource = axios.CancelToken.source();

            axios.put('/api/bacnet/scan', {}, { cancelToken: this.cancelTokenSource.token })
                .then(response => {
                    this.devices = response.data;
                    this.loading = false;
                    this.cancelTokenSource = null;
                })
                .catch(error => {
                    if (axios.isCancel(error)) {
                        console.log('Whois scan request canceled:', error.message);
                    } else {
                        console.error('Error during Whois scan:', error);
                    }
                    this.loading = false;
                    this.cancelTokenSource = null;
                });
        },
        stopWhoisScan() {
            if (this.cancelTokenSource) {
                this.cancelTokenSource.cancel('Scan stopped by user.');
            }
        }
    }
});

Vue.component('device-scan', {
    data() {
        return {
            loading: false,
            deviceId: null, 
            address: null,  
            objects: null,
            showWriteForm: false,
            selectedObjectForWrite: null
        }
    },
    methods: {
        scanDevice() {
            this.loading = true; 
            axios.put('/api/bacnet/' + this.deviceId + '/objects', { 
                deviceId: this.deviceId,
                address: this.address  
            }).then(response => {
                this.objects = response.data;
                this.loading = false;
            }).catch(error => {
                this.loading = false;
            });
        },
        openWriteForm(scannedObject) {
            this.selectedObjectForWrite = {
                parentDeviceId: this.deviceId, 
                objectType: scannedObject.objectId.type,
                objectInstance: scannedObject.objectId.instance,
                initialObjectName: scannedObject.name
            };
            this.showWriteForm = true;
        },
        closeWriteForm() {
            this.showWriteForm = false;
            this.selectedObjectForWrite = null;
        },
        handleWriteSuccessful() {
            this.closeWriteForm();
            // Optionally, could re-trigger scanDevice() if desired, but might be too aggressive
            // this.scanDevice(); 
        },
        getObjects(device) { 
            console.log(device);
        }
    }
});

Vue.component('object-write-form', {
    props: ['deviceId', 'objectType', 'objectInstance', 'initialObjectName'],
    template: '#object-write-form-template', 
    data() {
        return {
            loading: false,
            valueToWrite: null,
            propertyId: 85, 
            priority: null, 
            bacnetApplicationTag: null, 
            writeStatus: null,
            errorMessage: null,
            commonProperties: [
                { text: 'Present Value (85)', value: 85 },
                { text: 'Object Name (77)', value: 77 },
                { text: 'Description (28)', value: 28 },
                { text: 'Reliability (103)', value: 103 },
                { text: 'Out Of Service (81)', value: 81 },
            ],
            commonAppTags: [
                { text: 'NULL (0)', value: 0 },
                { text: 'BOOLEAN (1)', value: 1 },
                { text: 'UNSIGNED_INT (2)', value: 2 },
                { text: 'SIGNED_INT (3)', value: 3 },
                { text: 'REAL (4)', value: 4 },
                { text: 'DOUBLE (5)', value: 5 },
                { text: 'CHARACTER_STRING (7)', value: 7 },
                { text: 'ENUMERATED (9)', value: 9 },
            ]
        };
    },
    methods: {
        submitWrite() {
            this.loading = true;
            this.writeStatus = null;
            this.errorMessage = null;

            const payload = {
                deviceId: this.deviceId,
                objectType: parseInt(this.objectType),
                objectInstance: parseInt(this.objectInstance),
                propertyId: parseInt(this.propertyId),
                value: this.valueToWrite, 
            };

            if (this.priority !== null && this.priority !== '') {
                payload.priority = parseInt(this.priority);
            }
            if (this.bacnetApplicationTag !== null && this.bacnetApplicationTag !== '') {
                payload.bacnetApplicationTag = parseInt(this.bacnetApplicationTag);
            }

            axios.put('/api/bacnet/write', payload)
                .then(response => {
                    this.loading = false;
                    this.writeStatus = 'success';
                    this.errorMessage = `Success: ${response.data.message || JSON.stringify(response.data)}`;
                    this.$emit('write-successful');
                })
                .catch(error => {
                    this.loading = false;
                    this.writeStatus = 'error';
                    if (error.response && error.response.data && error.response.data.message) {
                        this.errorMessage = `Error: ${error.response.data.message}`;
                    } else {
                        this.errorMessage = `Error: ${error.message || 'Failed to perform write operation.'}`;
                    }
                });
        },
        closeForm() {
            this.$emit('close-write-form');
        }
    }
});

Vue.component('configured-devices', {
    data() {
        return {
            devices: [],
            loading: false
        };
    },
    methods: {
        async load() {
            this.loading = true;
            try {
                const res = await axios.get('/api/bacnet/configured');
                this.devices = res.data || [];
            } catch (err) {
                console.error('Failed to load configured devices', err);
            } finally {
                this.loading = false;
            }
        }
    },
    created() {
        this.load();
    }
});

new Vue({
    el: "#app",
    data() {
        return {
            state: null,
            tokenValid: false,
            loginForm: { username: '', password: '' },
            loginLoading: false,
            loginError: null,
            currentUser: { username: '', role: '' },
            health: { status: 'unknown', mqtt: { connected: false }, bacnet: { configuredDevices: 0 } },
            changePasswordModal: false,
            changeForm: { oldPassword: '', newPassword: '' },
            changeError: null,
            changeSuccess: null
        }
    },
    methods: {
        async initAuth() {
            const token = await TokenVault.load();
            if (!token) {
                this.tokenValid = false;
                return;
            }
            const payload = parseJwt(token);
            if (!payload || !payload.exp || payload.exp * 1000 < Date.now()) {
                TokenVault.clear();
                this.tokenValid = false;
                return;
            }
            this.setAuth(token, payload);
        },
        setAuth(token, payload) {
            axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
            this.tokenValid = true;
            this.currentUser = { username: payload.username, role: payload.role };
            this.state = this.state || 'whois';
        },
        async login() {
            this.loginError = null;
            this.loginLoading = true;
            try {
                const res = await axios.post('/auth/login', {
                    username: this.loginForm.username,
                    password: this.loginForm.password
                });
                const token = res.data.token;
                const payload = parseJwt(token);
                if (!payload) {
                    throw new Error('Invalid token received');
                }
                await TokenVault.save(token);
                this.setAuth(token, payload);
                this.loginForm.password = '';
            } catch (err) {
                this.loginError = (err.response && err.response.data && err.response.data.message) ? err.response.data.message : err.message;
                TokenVault.clear();
            } finally {
                this.loginLoading = false;
            }
        },
        logout() {
            TokenVault.clear();
            delete axios.defaults.headers.common['Authorization'];
            this.tokenValid = false;
            this.state = null;
            this.currentUser = { username: '', role: '' };
        },
        showWhois() {
            this.state = 'whois';
        },
        showObjects() {
            this.state = 'objects';
        },
        showConfigured() {
            this.state = 'configured';
        },
        async loadHealth() {
            try {
                const res = await axios.get('/health');
                const data = res.data || {};
                this.health = {
                    status: data.status || 'unknown',
                    mqtt: data.mqtt || { connected: false },
                    bacnet: { configuredDevices: data.bacnet ? data.bacnet.configuredDevices : 0 }
                };
            } catch (err) {
                this.health = { status: 'degraded', mqtt: { connected: false }, bacnet: { configuredDevices: 0 } };
            }
        },
        openChangePassword() {
            this.changeError = null;
            this.changeSuccess = null;
            this.changeForm = { oldPassword: '', newPassword: '' };
            this.changePasswordModal = true;
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
                setTimeout(() => {
                    this.closeChangePassword();
                    this.logout();
                }, 800);
            } catch (err) {
                this.changeError = (err.response && err.response.data && err.response.data.message) ? err.response.data.message : 'Failed to change password';
            }
        }
    },
    created() {
        axios.interceptors.response.use(
            response => response,
            error => {
                if (error.response && error.response.status === 401) {
                    this.logout();
                }
                return Promise.reject(error);
            }
        );
        this.initAuth();
        setInterval(() => this.loadHealth(), 15000);
        this.loadHealth();
    }
});
