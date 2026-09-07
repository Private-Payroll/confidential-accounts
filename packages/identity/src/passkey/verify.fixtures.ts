/**
 * REAL BROWSER OUTPUT. Not constructed by us.
 *
 * Every value here came out of Chromium driving a CTAP2.1 virtual authenticator
 * over the DevTools protocol — the same code path a real platform authenticator
 * takes, with the same encodings, the same flag bytes and the same DER
 * signatures.
 *
 * WHY IT IS RECORDED RATHER THAN GENERATED IN THE TEST. A helper that builds a
 * registration by hand shares its author's model of the format, so a test using
 * one proves the code agrees with the person who wrote it — which is the exact
 * failure this project has been bitten by before. These bytes agree with a
 * browser.
 *
 * Each set carries a SECOND credential from the same authenticator, for a
 * different person, because "this assertion belongs to somebody else" is only
 * testable against a real one.
 *
 * `personHandle` is what was passed as `user.id`, and `userHandle` is what the
 * authenticator handed back at sign-in. **They must match**, and that they are
 * recorded separately rather than assumed equal is the point.
 *
 * Note the sign-in `clientDataJSON` values: Chrome inserts a field reading
 * "do not compare clientDataJSON against a template", deliberately, to break
 * code that string-matches. That is why this data is here.
 */

/**
 * A DEVICE-BOUND passkey. Neither backup flag set — a security key, or a
 * platform authenticator with cloud sync switched off.
 */
export const deviceBound = {
  rpId: 'localhost',
  origin: 'http://localhost:8951',
  registration: {
    challenge: 'AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw',
    credentialId: 'Gy8zUjIa3_6dq-KAVgiQ8hYvuOje_wI5m1wGy0-heiw',
    personHandle: 'cGVyc29uLWRldmljZUJvdW5k',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiQXdvUkdCOG1MVFE3UWtsUVYxNWxiSE42Z1lp'
      + 'UGxwMmtxN0s1d01mTzFkdyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODk1MSIsImNyb3NzT3JpZ2luIjpm'
      + 'YWxzZX0',
    authenticatorData:
      'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFAAAAAQECAwQFBgcIAQIDBAUGBwgAIBsvM1IyGt_-navi'
      + 'gFYIkPIWL7jo3v8COZtcBstPoXospQECAyYgASFYIOftoXj8jRRrf_O8-wdxHbdLLaoPE2xxHUIhePrNwhG3Ilgg'
      + 'EEFcxkP309pq9hvTb9ToYErRvZYYgPO7vFKKLtEDIYE',
    publicKeySpki:
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5-2hePyNFGt_87z7B3Edt0stqg8TbHEdQiF4-s3CEbcQQVzGQ_fT'
      + '2mr2G9Nv1OhgStG9lhiA87u8Uoou0QMhgQ',
    publicKeyAlgorithm: -7,
    transports: ['internal'],
  },
  /** A different person, same authenticator. */
  otherRegistration: {
    challenge: 'MG2q5yRhntsYVZLPDEmGwwA9erf0MW6r6CVin9wZVpM',
    credentialId: 'T5dvi4lcjsrHVbTLx7-FtPvsFoPuNmaO1BQdc6ROyco',
    personHandle: 'b3RoZXItZGV2aWNlQm91bmQ',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiTUcycTV5UmhudHNZVlpMUERFbUd3d0E5ZXJm'
      + 'ME1XNnI2Q1Zpbjl3WlZwTSIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODk1MSIsImNyb3NzT3JpZ2luIjpm'
      + 'YWxzZX0',
    authenticatorData:
      'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFAAAAAQECAwQFBgcIAQIDBAUGBwgAIE-Xb4uJXI7Kx1W0'
      + 'y8e_hbT77BaD7jZmjtQUHXOkTsnKpQECAyYgASFYIHQiQAfFTwmg1jt9O4x5pGxC5ND80OhZA1PqfU4H-C-sIlgg'
      + 'lMSDh6zNeraoG5sd-3BIqN7Eq_pg2cWZwedzgqw-jHc',
    publicKeySpki:
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdCJAB8VPCaDWO307jHmkbELk0PzQ6FkDU-p9Tgf4L6yUxIOHrM16'
      + 'tqgbmx37cEio3sSr-mDZxZnB53OCrD6Mdw',
    publicKeyAlgorithm: -7,
    transports: ['internal'],
  },
  signIn: {
    challenge: 'CBUiLzxJVmNwfYqXpLG-y9jl8v8MGSYzQE1aZ3SBjps',
    credentialId: 'Gy8zUjIa3_6dq-KAVgiQ8hYvuOje_wI5m1wGy0-heiw',
    userHandle: 'cGVyc29uLWRldmljZUJvdW5k',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiQ0JVaUx6eEpWbU53ZllxWHBMRy15OWpsOHY4TUdT'
      + 'WXpRRTFhWjNTQmpwcyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODk1MSIsImNyb3NzT3JpZ2luIjpmYWxz'
      + 'ZSwib3RoZXJfa2V5c19jYW5fYmVfYWRkZWRfaGVyZSI6ImRvIG5vdCBjb21wYXJlIGNsaWVudERhdGFKU09OIGFn'
      + 'YWluc3QgYSB0ZW1wbGF0ZS4gU2VlIGh0dHBzOi8vZ29vLmdsL3lhYlBleCJ9',
    authenticatorData:
      'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAg',
    signature:
      'MEYCIQCNBqKrDngctdh1OtbHJeEB0Kn3IHAnSOdBWudhXfhVdgIhAMhmleuPIx0GDgsxt3Io4raqVjVwaofmSKGc'
      + 'IrIfqMLz',
  },
} as const;

/**
 * A SYNCED passkey — both backup flags set. This is what an iCloud Keychain or
 * Google Password Manager credential looks like, which is most people.
 */
export const synced = {
  rpId: 'localhost',
  origin: 'http://localhost:8952',
  registration: {
    challenge: 'AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw',
    credentialId: 'qBYChvD2bbJVg0r9A6FphHvd1Bx2h9-E8AtcRlVO7WY',
    personHandle: 'cGVyc29uLXN5bmNlZA',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiQXdvUkdCOG1MVFE3UWtsUVYxNWxiSE42Z1lp'
      + 'UGxwMmtxN0s1d01mTzFkdyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODk1MiIsImNyb3NzT3JpZ2luIjpm'
      + 'YWxzZX0',
    authenticatorData:
      'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NdAAAAAQECAwQFBgcIAQIDBAUGBwgAIKgWAobw9m2yVYNK'
      + '_QOhaYR73dQcdoffhPALXEZVTu1mpQECAyYgASFYIPTrQmD4jUxUA1SZA83GyfmXpVrP1NUN4vDwRVXlqDquIlgg'
      + 'RX00c-hRdqPn17qDmkiUPKv1o2gj_M5AFAe9ZkMsm4g',
    publicKeySpki:
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE9OtCYPiNTFQDVJkDzcbJ-ZelWs_U1Q3i8PBFVeWoOq5FfTRz6FF2'
      + 'o-fXuoOaSJQ8q_WjaCP8zkAUB71mQyybiA',
    publicKeyAlgorithm: -7,
    transports: ['internal'],
  },
  /** A different person, same authenticator. */
  otherRegistration: {
    challenge: 'MG2q5yRhntsYVZLPDEmGwwA9erf0MW6r6CVin9wZVpM',
    credentialId: 'EK6sQOFXO0zjs2GgXMXSa4aycvB4Mu4q7XyOx-XqTPI',
    personHandle: 'b3RoZXItc3luY2Vk',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiTUcycTV5UmhudHNZVlpMUERFbUd3d0E5ZXJm'
      + 'ME1XNnI2Q1Zpbjl3WlZwTSIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODk1MiIsImNyb3NzT3JpZ2luIjpm'
      + 'YWxzZX0',
    authenticatorData:
      'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NdAAAAAQECAwQFBgcIAQIDBAUGBwgAIBCurEDhVztM47Nh'
      + 'oFzF0muGsnLweDLuKu18jsfl6kzypQECAyYgASFYICADXB3tmUDmVPNSOOPNUcq9l3ERRxHXTqKYf8LLm0m2Ilgg'
      + 'qumShXmYNMpdIvpvkfr31Gh03PgrEmozeXKj3gkuUnE',
    publicKeySpki:
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEIANcHe2ZQOZU81I4481Ryr2XcRFHEddOoph_wsubSbaq6ZKFeZg0'
      + 'yl0i-m-R-vfUaHTc-CsSajN5cqPeCS5ScQ',
    publicKeyAlgorithm: -7,
    transports: ['internal'],
  },
  signIn: {
    challenge: 'CBUiLzxJVmNwfYqXpLG-y9jl8v8MGSYzQE1aZ3SBjps',
    credentialId: 'qBYChvD2bbJVg0r9A6FphHvd1Bx2h9-E8AtcRlVO7WY',
    userHandle: 'cGVyc29uLXN5bmNlZA',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiQ0JVaUx6eEpWbU53ZllxWHBMRy15OWpsOHY4TUdT'
      + 'WXpRRTFhWjNTQmpwcyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODk1MiIsImNyb3NzT3JpZ2luIjpmYWxz'
      + 'ZX0',
    authenticatorData:
      'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MdAAAAAg',
    signature:
      'MEUCIGPw8vfC_4H_HEL80JwZuLTrssMc7ZAtxpJY1MBbRbesAiEA5APXtskhndmtG57kJ8Ii_Tv3r2L_FLtj3Wnl'
      + '7IxRSFg',
  },
} as const;

/**
 * TWO SUCCESSIVE SIGN-INS from one credential, counters 2 then 3.
 *
 * The only way to test the clone detector on genuine data: replaying the FIRST
 * of these after the second has been recorded is a real, correctly signed,
 * perfectly valid assertion that must still be refused. Corrupting bytes proves
 * the signature check; this proves the counter check.
 */
export const twoSignIns = {
  rpId: 'localhost',
  origin: 'http://localhost:8953',
  registration: {
    challenge: 'AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw',
    credentialId: 'qFrlDoNKA6C41kIbjhJn-JsGLIyx3A3peT1qqW_2XnQ',
    personHandle: 'cGVyc29uLXR3b1NpZ25JbnM',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiQXdvUkdCOG1MVFE3UWtsUVYxNWxiSE42Z1lp'
      + 'UGxwMmtxN0s1d01mTzFkdyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODk1MyIsImNyb3NzT3JpZ2luIjpm'
      + 'YWxzZX0',
    authenticatorData:
      'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NdAAAAAQECAwQFBgcIAQIDBAUGBwgAIKha5Q6DSgOguNZC'
      + 'G44SZ_ibBiyMsdwN6Xk9aqlv9l50pQECAyYgASFYIHSxbRHMEgRT6XXlUu3XGSR1Dx-dlxhP9WHsWspGuJoAIlgg'
      + '8C7aCsj02gWgExuaevV13IbCHrOt4Uou1zjXi-vo6O0',
    publicKeySpki:
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdLFtEcwSBFPpdeVS7dcZJHUPH52XGE_1Yexayka4mgDwLtoKyPTa'
      + 'BaATG5p69XXchsIes63hSi7XONeL6-jo7Q',
    publicKeyAlgorithm: -7,
    transports: ['internal'],
  },
  /** A different person, same authenticator. */
  otherRegistration: {
    challenge: 'MG2q5yRhntsYVZLPDEmGwwA9erf0MW6r6CVin9wZVpM',
    credentialId: 'SD8YSwkej4NxWG8mUnhWg2pKDxar04ZeaOzp7nBL0B4',
    personHandle: 'b3RoZXItdHdvU2lnbklucw',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiTUcycTV5UmhudHNZVlpMUERFbUd3d0E5ZXJm'
      + 'ME1XNnI2Q1Zpbjl3WlZwTSIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODk1MyIsImNyb3NzT3JpZ2luIjpm'
      + 'YWxzZX0',
    authenticatorData:
      'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NdAAAAAQECAwQFBgcIAQIDBAUGBwgAIEg_GEsJHo-DcVhv'
      + 'JlJ4VoNqSg8Wq9OGXmjs6e5wS9AepQECAyYgASFYIKRYCI-0Y-T6Kb0bCrUvO2ggCMDRoKqDfvsXctC8Y_KhIlgg'
      + '-4qEfYkcd2_YovangJpBAmDlnuYoAh_nq9zAh8UDoBU',
    publicKeySpki:
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEpFgIj7Rj5PopvRsKtS87aCAIwNGgqoN--xdy0Lxj8qH7ioR9iRx3'
      + 'b9ii9qeAmkECYOWe5igCH-er3MCHxQOgFQ',
    publicKeyAlgorithm: -7,
    transports: ['internal'],
  },
  /** Counter 2. */
  firstSignIn: {
    challenge: 'CBUiLzxJVmNwfYqXpLG-y9jl8v8MGSYzQE1aZ3SBjps',
    credentialId: 'qFrlDoNKA6C41kIbjhJn-JsGLIyx3A3peT1qqW_2XnQ',
    userHandle: 'cGVyc29uLXR3b1NpZ25JbnM',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiQ0JVaUx6eEpWbU53ZllxWHBMRy15OWpsOHY4TUdT'
      + 'WXpRRTFhWjNTQmpwcyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODk1MyIsImNyb3NzT3JpZ2luIjpmYWxz'
      + 'ZX0',
    authenticatorData:
      'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MdAAAAAg',
    signature:
      'MEQCIB7pMQkR0-ni3LI-bx_pFK-nJyq8EJ9dXlWEIRGTGnQcAiA9RRtX0ZUqAdtOVxEFbJNiH7_1H7tmeTViBq54'
      + 'Bw12kA',
  },
  /** Counter 3, from the same credential moments later. */
  secondSignIn: {
    challenge: 'DSAzRllsf5KluMve8QQXKj1QY3aJnK_C1ej7DiE0R1o',
    credentialId: 'qFrlDoNKA6C41kIbjhJn-JsGLIyx3A3peT1qqW_2XnQ',
    userHandle: 'cGVyc29uLXR3b1NpZ25JbnM',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiRFNBelJsbHNmNUtsdU12ZThRUVhLajFRWTNhSm5L'
      + 'X0MxZWo3RGlFMFIxbyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODk1MyIsImNyb3NzT3JpZ2luIjpmYWxz'
      + 'ZX0',
    authenticatorData:
      'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MdAAAAAw',
    signature:
      'MEQCIEHkas5dWA_I7xvlV9fptAMJ6YaQWOL9A0_N0z6iJOZZAiB4GnXsY6QZlGhTQbHZwZZcfmw_C7XIRpDH-L9t'
      + 'RDG28g',
  },
} as const;

/**
 * BACKUP-ELIGIBLE BUT NOT YET BACKED UP — the two flags disagreeing.
 *
 * Every other fixture has them agreeing, which means a verifier reading one
 * where it meant the other passed the whole suite. It did, until this existed.
 * **Two flags that always agree in the data are one flag.**
 *
 * It is also a real state a person is in: a passkey made on an iPhone with
 * iCloud Keychain switched off. It is the case where "your passkey is safely
 * synced" would be a lie.
 */
export const eligibleOnly = {
  rpId: 'localhost',
  origin: 'http://localhost:8954',
  registration: {
    challenge: 'AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw',
    credentialId: '9Vbi69VazPIgrgEuQWR0XAXB1E4UfpUMmNwPd1KhNk8',
    personHandle: 'cGVyc29uLWVsaWdpYmxlT25seQ',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiQXdvUkdCOG1MVFE3UWtsUVYxNWxiSE42Z1lp'
      + 'UGxwMmtxN0s1d01mTzFkdyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODk1NCIsImNyb3NzT3JpZ2luIjpm'
      + 'YWxzZSwib3RoZXJfa2V5c19jYW5fYmVfYWRkZWRfaGVyZSI6ImRvIG5vdCBjb21wYXJlIGNsaWVudERhdGFKU09O'
      + 'IGFnYWluc3QgYSB0ZW1wbGF0ZS4gU2VlIGh0dHBzOi8vZ29vLmdsL3lhYlBleCJ9',
    authenticatorData:
      'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NNAAAAAQECAwQFBgcIAQIDBAUGBwgAIPVW4uvVWszyIK4B'
      + 'LkFkdFwFwdROFH6VDJjcD3dSoTZPpQECAyYgASFYIMsPg939XaqhNdZBOZxt51OApHSepEwvVX-BDzP3T8u7Ilgg'
      + '87d3l9J3rb8-SsISFzzYDw4X1oG1wWdG6nImUpHoaEQ',
    publicKeySpki:
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyw-D3f1dqqE11kE5nG3nU4CkdJ6kTC9Vf4EPM_dPy7vzt3eX0net'
      + 'vz5KwhIXPNgPDhfWgbXBZ0bqciZSkehoRA',
    publicKeyAlgorithm: -7,
    transports: ['internal'],
  },
  /** A different person, same authenticator. */
  otherRegistration: {
    challenge: 'MG2q5yRhntsYVZLPDEmGwwA9erf0MW6r6CVin9wZVpM',
    credentialId: 'XnS7aCkk1twCoovnp1t68_TGBuHyj9gb_J7rWuIQR_k',
    personHandle: 'b3RoZXItZWxpZ2libGVPbmx5',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiTUcycTV5UmhudHNZVlpMUERFbUd3d0E5ZXJm'
      + 'ME1XNnI2Q1Zpbjl3WlZwTSIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODk1NCIsImNyb3NzT3JpZ2luIjpm'
      + 'YWxzZSwib3RoZXJfa2V5c19jYW5fYmVfYWRkZWRfaGVyZSI6ImRvIG5vdCBjb21wYXJlIGNsaWVudERhdGFKU09O'
      + 'IGFnYWluc3QgYSB0ZW1wbGF0ZS4gU2VlIGh0dHBzOi8vZ29vLmdsL3lhYlBleCJ9',
    authenticatorData:
      'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NNAAAAAQECAwQFBgcIAQIDBAUGBwgAIF50u2gpJNbcAqKL'
      + '56dbevP0xgbh8o_YG_ye61riEEf5pQECAyYgASFYIOO8WC9yZ4ZhSdgJVylMgyK6W5Rwyv4TgbYcIWvNGsMIIlgg'
      + 'OF0X3BTJqOQSITXgQlKTGEN8_oV47L_N0dFRgnybrx8',
    publicKeySpki:
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE47xYL3JnhmFJ2AlXKUyDIrpblHDK_hOBthwha80awwg4XRfcFMmo'
      + '5BIhNeBCUpMYQ3z-hXjsv83R0VGCfJuvHw',
    publicKeyAlgorithm: -7,
    transports: ['internal'],
  },
} as const;
