import ipaddr from 'ipaddr.js';
import type { IngressRule } from './types/capa';


const ipv4CidrBlocks = (t: (key: string) => string, blocks: string[] = []) => {
  try {
    const invalid = blocks.find((cidr) => !ipaddr.IPv4.isValidCIDR(cidr));

    return invalid ? t('capa.errors.invalidIpv4Cidr') : null;
  } catch {
    return t('capa.errors.invalidIpv4Cidr');
  }
};

const ipv6CidrBlocks = (t: (key: string) => string, blocks: string[] = []) => {
  try {
    const invalid = blocks.find((cidr) => !ipaddr.IPv6.isValidCIDR(cidr));

    return invalid ? t('capa.errors.invalidIpv6Cidr') : null;
  } catch {
    return t('capa.errors.invalidIpv6Cidr');
  }
};

const validateIngressRulesCidr = (t: (key: string) => string, additionalRules = [] as IngressRule[]) => {
  const allIpv4 = additionalRules.flatMap((r = {} as IngressRule) => r.cidrBlocks || []);
  const allIpv6 = additionalRules.flatMap((r = {} as IngressRule) => r.ipv6CidrBlocks || []);

  return ipv4CidrBlocks(t, allIpv4) ?? ipv6CidrBlocks(t, allIpv6) ?? true;
};

const vpc = (t: (key: string) => string, val: string, useUnmanagedNetwork: boolean) => {
    if (!useUnmanagedNetwork) {
    return true;
    }

    return val && val !== '' ? true : t('capa.errors.vpcRequired');
}

const subnet = (t: (key: string) => string, val: string[], useUnmanagedNetwork: boolean) => {
    if (!useUnmanagedNetwork) {
    return true;
    }

    return val && val.length > 0 ? true : t('capa.errors.subnetRequired');
}

const cidrBlock = (t: (key: string) => string, val: string, useUnmanagedNetwork: boolean) => {
    if (useUnmanagedNetwork || !val) {
    return true;
    }
    let isValid = false;

    try {
    isValid = ipaddr.isValidCIDR(val);
    } catch {
    return t('capa.errors.vpcCidrBlock');
    }

    return isValid ?? t('capa.errors.vpcCidrBlock');
}

const region = (t: (key: string) => string, val: string) => {
    return val && val !== '' ? true : t('capa.errors.regionRequired');
}

export { validateIngressRulesCidr, vpc, subnet, cidrBlock, ipv4CidrBlocks, ipv6CidrBlocks, region };