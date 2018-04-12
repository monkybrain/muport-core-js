const IPFS = require('ipfs-mini')
const promisifyAll = require('bluebird').promisifyAll
const resolve = require('did-resolver')
const registerMuportResolver = require('muport-did-resolver')
const didJWT = require('did-jwt')
const bs58 = require('bs58')
const Keyring = require('./keyring')
const EthereumUtils = require('./ethereum-utils')

const IPFS_CONF = { host: 'ipfs.infura.io', port: 5001, protocol: 'https' }
let ipfs

class MuPort {

  constructor (opts = {}) {
    if (!opts.did || !opts.document || !opts.keyring) {
      throw new Error('Data missing for restoring identity')
    }
    initIpfs(opts.ipfsConf)
    this.did = opts.did
    this.document = opts.document
    this.documentHash = opts.documentHash || this.did.split(':')[2]
    this.keyring = new Keyring(opts.keyring)

    // TODO - verify integrity of identity (resolving ID should result in the same did document, etc)

    this.ethUtils = new EthereumUtils(opts.rpcProviderUrl)
    registerMuportResolver({ ipfsConf: opts.ipfsConf, rpcProviderUrl: opts.rpcProviderUrl })
  }

  async helpRecover (did) {
    const muportDoc = await MuPort.resolveIdentityDocument(did)

    return this.keyring.decryptOneShare(muportDoc.recoveryNetwork, muportDoc.asymEncryptionKey, this.did)
  }

  getDid() {
    return this.did
  }

  getDidDocument () {
    return this.document
  }

  getRecoveryDelegateDids () {
    const toBuffer = true
    let dids = []
    if (this.document.symEncryptedData.symEncDids != undefined){
      dids = this.document.symEncryptedData.symEncDids.map(
        (encDid) => bufferToDid(this.keyring.symDecrypt(encDid.ciphertext, encDid.nonce, toBuffer))
      )
    }
    return dids
  }

  async updateDelegates (delegateDids) {
    if (delegateDids.length !== 3) throw new Error('Must provide exactly 3 DIDs')
    // generate new recoveryNetwork
    const didsPublicKeys = await Promise.all(delegateDids.map(async did => (await MuPort.resolveIdentityDocument(did)).asymEncryptionKey))
    const recoveryNetwork = await this.keyring.createShares(delegateDids, didsPublicKeys)

    this.document.recoveryNetwork = recoveryNetwork
    this.documentHash = await ipfs.addJSONAsync(this.document)

    const address = this.keyring.getManagementAddress()
    const txParams = await this.ethUtils.createPublishTxParams(this.documentHash, address)
    const costInEther = this.ethUtils.calculateTxCost(txParams)
    const signedTx = this.keyring.signManagementTx(txParams)

    return {
      address,
      costInEther,
      finishUpdate: async () => {
        await this.ethUtils.sendRawTx(signedTx)
      }
    }
  }

  async signJWT (payload) {
    const settings = {
      signer: this.keyring.getJWTSigner(),
      issuer: this.did
      // TODO - should we have an expiry?
    }
    return didJWT.createJWT(payload, settings)
  }

  async verifyJWT (jwt, audience = this.did) {
    return didJWT.verifyJWT(jwt, {audience})
  }

  serializeState () {
    return {
      did: this.did,
      document: this.document,
      documentHash: this.documentHash,
      keyring: this.keyring.serialize()
    }
  }

  static async newIdentity (name, delegateDids, opts = {}) {
    initIpfs(opts.ipfsConf)
    const publicProfile = { name }
    const keyring = new Keyring()
    let recoveryNetwork
    let symEncryptedDelegateDids
    if (delegateDids) {
      const didsPublicKeys = await Promise.all(delegateDids.map(async did => (await MuPort.resolveIdentityDocument(did, opts)).asymEncryptionKey))
      recoveryNetwork = await keyring.createShares(delegateDids, didsPublicKeys)

      symEncryptedDelegateDids = delegateDids.map((did) => keyring.symEncrypt(didToBuffer(did)))

    }
    const publicKeys = keyring.getPublicKeys()

    const doc = createMuportDocument(publicKeys, recoveryNetwork, publicProfile, {symEncDids: symEncryptedDelegateDids})
    const docHash = await ipfs.addJSONAsync(doc)
    const did = 'did:muport:' + docHash

    return new MuPort({
      did,
      document: doc,
      documentHash: docHash,
      keyring: keyring.serialize(),
      ...opts
    })
  }

  static async recoverIdentity (did, shares, opts = {}) {
    initIpfs(opts.ipfsConf)
    return new MuPort({
      did,
      document: await MuPort.resolveIdentityDocument(did, opts),
      keyring: (await Keyring.recoverKeyring(shares)).serialize(),
      ...opts
    })
  }

  static async resolveIdentityDocument (did, opts) {
    if (opts) {
      registerMuportResolver({ ipfsConf: opts.ipfsConf, rpcProviderUrl: opts.rpcProviderUrl })
    }
    const didDoc = await resolve(did)
    const publicKeys = {
      signingKey: didDoc.publicKey.find(key => (key.id.indexOf('#signingKey') !== -1)).publicKeyHex,
      managementKey: didDoc.publicKey.find(key => (key.id.indexOf('#managementKey') !== -1)).publicKeyHex,
      asymEncryptionKey: didDoc.publicKey.find(key => (key.id.indexOf('#encryptionKey') !== -1)).publicKeyBase64
    }
    const recoveryNetwork = didDoc.muportData.recoveryNetwork
    const publicProfile = {
      name: didDoc.muportData.nym
    }
    const symEncryptedData = didDoc.muportData.symEncryptedData
    return createMuportDocument(publicKeys, recoveryNetwork, publicProfile, symEncryptedData)
  }
}

const initIpfs = (ipfsConf) => {
  ipfs = promisifyAll(new IPFS(ipfsConf || IPFS_CONF))
}

const createMuportDocument = (publicKeys, recoveryNetwork, publicProfile, symEncryptedData) => {
  let doc = {
    version: 1,
    ...publicKeys
  }
  if (recoveryNetwork) {
    doc.recoveryNetwork = recoveryNetwork
  }
  if (publicProfile) {
    doc.publicProfile = publicProfile
  }
  if (symEncryptedData) {
    doc.symEncryptedData = symEncryptedData
  }
  return doc
}

const bufferToDid = (didBuffer) => {
  return ('did:muport:' + bs58.encode(didBuffer))
}

const didToBuffer = (didUri) => {
  const hash = didUri.split(':')[2]
  return bs58.decode(hash)
}

module.exports = MuPort
