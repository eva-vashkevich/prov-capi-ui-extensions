<script setup lang="ts">
import {
  computed, onMounted, toRefs, ref, WritableComputedRef, watch
} from 'vue';
import { useStore } from 'vuex';
import { useI18n } from '@shell/composables/useI18n';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import { RcSection } from '@components/RcSection';
import { _CREATE } from '@shell/config/query-params';
import merge from 'lodash/merge';
import Networking from './Networking.vue';
import { removeEmptyFields } from '../utils';
import { NORMAN } from '@shell/config/types';
import { isEmpty, set } from '@shell/utils/object.js';
import KeyValue from '@shell/components/form/KeyValue.vue';
import * as AWS from '@shell/types/aws-sdk';
import { useForm } from 'vee-validate';
import ipaddr from 'ipaddr.js';

defineOptions({ name: 'ClusterConfiguration' });

const emit = defineEmits<{(e: 'update:value', value: any): void, (e: 'validationChanged', value: boolean): void }>();

const defaultConfig = {
  spec: {
    network: {
      additionalControlPlaneIngressRules: [{
        protocol: '-1', sourceSecurityGroupRoles: ['controlplane', 'node'], description: 'Allow all traffic between control plane and node security groups'
      }],
      additionalNodeIngressRules: [{
        protocol: '-1', sourceSecurityGroupRoles: ['controlplane', 'node'], description: 'Allow all traffic between control plane and node security groups'
      }],
      cni:                    { cniIngressRules: [] },
      securityGroupOverrides: {},
      vpc:                    {},
    },
    sshKeyName:               '',
    additionalTags:           {},
    identityRef:              { name: 'cluster-identity', kind: 'AWSClusterStaticIdentity' },
    controlPlaneLoadBalancer: {
      healthCheckProtocol: 'TCP',
      loadBalancerType:    'nlb'
    }
  }
};

interface Props {
  value: any;
  mode: string;
  provider?: string;
  credentialId?: any;
  provisioningCluster?: any;
}

const props = withDefaults(defineProps<Props>(), {
  mode:                _CREATE,
  value:               () => ({ spec: {} }),
  provider:            '',
  credentialId:        null,
  provisioningCluster: {}
});

const {
  mode,
  value,
  credentialId,
  provisioningCluster,
} = toRefs(props);

// Ensure spec is always present and reactive
// TODO nb needed vs computed props?
if (value.value && !value.value.spec) {
  value.value.spec = {};
}

const store = useStore();
const { t } = useI18n(store);
const useUnmanagedNetwork = ref(false); // used by a radio in networking and doesn't correspond to anything in cluster config - tracking it here to use w/ validators
// const config = ref({});
const ec2Client = ref(null);
const regionInfo = ref([]);
const sshKeyInfo = ref([]);
const loadingRegions = ref(false);
const loadingSshKeys = ref(false);
const vpcInfo = ref<AWS.VPC[]>([]);
const subnetInfo = ref<AWS.Subnet[]>([]);
const loadingVpcs = ref(false);
const loadingSubnets = ref(false);

const validateIngressRulesCidr = (additionalRules = []) => {
  try {
    const invalidCidr = additionalRules.find((r = {}) => {
      const { cidrBlocks = [] } = r;

      return cidrBlocks.find((cidr) => !ipaddr.isValidCIDR(cidr));
    });

    return invalidCidr ? 'Invalid CIDR format' : true;
  } catch {
    return 'Invalid CIDR format';
  }
};

// TODO nb localize error messages
const { errors, validate, validateField } = useForm({
  validationSchema: {
    vpc: (val: string) => {
      if (!useUnmanagedNetwork.value) {
        return true;
      }

      return val && val !== '' ? true : 'VPC is required';
    },

    subnet: (val: string[]) => {
      if (!useUnmanagedNetwork.value) {
        return true;
      }

      return val && val.length > 0 ? true : 'At least one subnet is required';
    },

    cidrBlock: (val: string) => {
      if (useUnmanagedNetwork.value || !val) {
        return true;
      }
      let isValid = false;

      try {
        isValid = ipaddr.isValidCIDR(val);
      } catch {
        return 'Invalid CIDR format';
      }

      return isValid ?? 'Invalid CIDR format';
    },

    region: (val: string) => {
      return val && val !== '' ? true : 'Region is required';
    },

    nodeIngressCidr: () => validateIngressRulesCidr(additionalNodeIngressRules.value),

    cpIngressCidr: () => validateIngressRulesCidr(additionalControlPlaneIngressRules.value),

    cniIngressCidr: () => validateIngressRulesCidr(cniIngressRules.value),
  }
});

// TODO nb generic set-if-not-set for region, sshKeyName, vpcId, firstSubnetId, se3curityGroupOverrides, xyzIngressRules
// use object util set to set nested fields that may not exist yet
// how to delete? tbd
const region: WritableComputedRef<string> = computed({
  get: () => value?.value?.spec?.region || '',
  set: (newRegion: string) => {
    if (value.value) {
      value.value.spec = value.value.spec || {};
      value.value.spec.region = newRegion;
    }
    emit('update:value', value.value);
  },
});

const sshKeyName: WritableComputedRef<string> = computed({
  get: () => value?.value?.spec?.sshKeyName || '',
  set: (newKey: string) => {
    if (value.value) {
      value.value.spec = value.value.spec || {};
      value.value.spec.sshKeyName = newKey;
    }
    emit('update:value', value.value);
  },
});

const vpcId: WritableComputedRef<string> = computed({
  get: () => value?.value?.spec?.network?.vpc?.id || '',
  set: (vpc: string) => {
    if (value.value) {
      if (!value.value?.spec?.network?.vpc) {
        set(value.value, 'spec.network.vpc', { id: vpc });
      } else {
        value.value.spec.network.vpc.id = vpc;
      }
    }
    emit('update:value', value.value);
  },
});

const cidrBlock: WritableComputedRef<string> = computed({
  get: () => value?.value?.spec?.network?.vpc?.cidrBlock || '',
  set: (cidr: string) => {
    if (value.value) {
      set(value.value, 'spec.network.vpc.cidrBlock', cidr);
    }
    emit('update:value', value.value);
  },
});

const ipv6: WritableComputedRef<string> = computed({
  get: () => value?.value?.spec?.network?.ipv6 || null,
  set: (neu: object | undefined) => {
    if (value.value && neu) {
      if (!value.value.spec.network) {
        set(value.value, 'spec.network', {});
      }
      value.value.spec.network.ipv6 = neu;
    } else {
      delete value.value.spec.network.ipv6;
    }
    emit('update:value', value.value);
  },
});

const securityGroupOverrides: WritableComputedRef<{}> = computed({
  get: () => value?.value?.spec?.network?.securityGroupOverrides || {},
  set: (neu: any) => {
    if (value.value) {
      if (!value.value?.spec?.network) {
        set(value.value, 'spec.network', { securityGroupOverrides: neu });
      } else {
        value.value.spec.network.securityGroupOverrides = neu;
      }
    }
    emit('update:value', value.value);
  },
});

const subnets: WritableComputedRef<{id: string}[]> = computed({
  get: () => value?.value?.spec?.network?.subnets || [],
  set: (neu: {id: string}[]) => {
    if (value.value) {
      if (!value.value?.spec?.network) {
        set(value.value, 'spec.network', { subnets: neu });
      } else {
        value.value.spec.network.subnets = neu;
      }
    }
    emit('update:value', value.value);
  },
});

const additionalControlPlaneIngressRules = computed({
  get: () => value?.value?.spec?.network?.additionalControlPlaneIngressRules || [],
  set: (rules: any[]) => {
    if (value.value) {
      if (!value.value?.spec?.network) {
        set(value.value, 'spec.network', {});
      }
      value.value.spec.network.additionalControlPlaneIngressRules = rules;
    }
    emit('update:value', value.value);
  },
});

const additionalNodeIngressRules = computed({
  get: () => value?.value?.spec?.network?.additionalNodeIngressRules || [],
  set: (rules: any[]) => {
    if (value.value) {
      if (!value.value?.spec?.network) {
        set(value.value, 'spec.network', {});
      }
      value.value.spec.network.additionalNodeIngressRules = rules;
    }
    emit('update:value', value.value);
  },
});

const additionalTags = computed({
  get: () => value?.value?.spec?.additionalTags || {},
  set: (tags: {}) => {
    if (value.value) {
      set(value.value, 'spec.additionalTags', tags);
    }
    emit('update:value', value.value);
  },
});

const cniIngressRules = computed({
  get: () => value?.value?.spec?.network?.cni?.cniIngressRules || [],
  set: (rules: any[]) => {
    if (value.value) {
      if (!value.value?.spec?.network) {
        set(value.value, 'spec.network', {});
      }
      if (!value.value.spec.network.cni) {
        value.value.spec.network.cni = {};
      }
      value.value.spec.network.cni.cniIngressRules = rules;
    }
    emit('update:value', value.value);
  },
});

const regionOptions = computed(() => {
  if ( !regionInfo.value ) {
    return [];
  }

  return regionInfo.value.map((obj) => {
    return obj.RegionName;
  }).sort();
});

const sshKeyOptions = computed(() => {
  const noneOption = { label: t('capa.clusterConfig.sshKeyName.noneLabel'), value: '' };

  if (!sshKeyInfo.value) {
    return [noneOption];
  }

  return [noneOption, ...sshKeyInfo.value.map((k) => {
    return { label: k.KeyName, value: k.KeyPairId };
  })];
});

function initDefaultRegion() {
  let cloudCredential;

  try {
    cloudCredential = credentialId.value ? store.getters['rancher/byId']( NORMAN.CLOUD_CREDENTIAL, credentialId.value ) : {};
  } catch {
    // TODO nb cant load default region?
  }
  const region = value.value?.spec?.region || cloudCredential?.amazonec2credentialConfig?.defaultRegion || store.getters['aws/defaultRegion'];

  if (!value.value?.spec?.region) {
    value.value.spec.region = region;
  }
}

async function getRegions() {
  loadingRegions.value = true;
  // TODO get regions based on credentials
  if (!ec2Client.value || !region.value || !credentialId.value) {
    regionInfo.value = [];

    return;
  }

  const regions = await ec2Client.value.describeRegions({});

  regionInfo.value = regions?.Regions || [];
  loadingRegions.value = false;
}

async function getSshKeys() {
  loadingSshKeys.value = true;
  if (!ec2Client.value || !region.value || !credentialId.value) {
    sshKeyInfo.value = [];

    return;
  }

  // TODO nb does this work
  const keys = await ec2Client.value.describeKeyPairs({});

  sshKeyInfo.value = keys.KeyPairs || [];
  loadingSshKeys.value = false;
}

async function getVpcs() {
  loadingVpcs.value = true;

  if (!ec2Client.value) {
    vpcInfo.value = [];
    loadingVpcs.value = false;

    return;
  }

  //TODO nb no custom store method
  const vpcs = await store.dispatch('aws/describeVpcs', { client: ec2Client.value });

  vpcInfo.value = vpcs || [];
  loadingVpcs.value = false;
}

async function getSubnets() {
  loadingSubnets.value = true;
  if (!ec2Client.value) {
    subnetInfo.value = [];
    loadingSubnets.value = false;

    return;
  }

  //TODO nb no custom store method
  const fetchedSubnets = await store.dispatch('aws/describeSubnets', { client: ec2Client.value });

  subnetInfo.value = fetchedSubnets || [];
  loadingSubnets.value = false;
}

onMounted(async() => {
  initDefaultRegion();

  ec2Client.value = await store.dispatch('aws/ec2', {
    region:            region.value,
    cloudCredentialId: credentialId.value
  });
  getRegions();
  getSshKeys();
  getVpcs();
  getSubnets();

  // TODO nb remove non-required field
  // TODO nb need to be very careful about removing 'empty' fields - does empty object get removed? empty array? should empty string be removed?
  if (mode.value === _CREATE) {
    const valueWithDefaults = merge({}, defaultConfig, value.value);
    const cleanedValueWithDefaults = removeEmptyFields(valueWithDefaults);

    delete cleanedValueWithDefaults.spec.s3Bucket;

    emit('update:value', cleanedValueWithDefaults || {});
  }
});

watch(errors, (neu = {}) => {
  emit('validationChanged', isEmpty(neu));
});

watch(useUnmanagedNetwork, (neu, old) => {
  if (old && !neu) {
    securityGroupOverrides.value = {};
  }
});

// secuirtyGroupoverrides cleared in their component
// TODO nb clear all of these in their respective components?
watch(vpcId, () => {
  subnets.value = [];
  additionalControlPlaneIngressRules.value.forEach((r: any) => {
    if (r.sourceSecurityGroupIDs) {
      delete r.sourceSecurityGroupIDs;
    }
  });
  additionalNodeIngressRules.value.forEach((r: any) => {
    if (r.sourceSecurityGroupIDs) {
      delete r.sourceSecurityGroupIDs;
    }
  });
});

watch([
  () => region.value,
  () => credentialId.value,
], async([newRegion, newCredentialId]) => {
  if (!!newRegion && !!newCredentialId) {
    // clear out vpc when region changes
    // this will trigger removal of any vpc-dependent configuration as well
    vpcId.value = '';

    ec2Client.value = await store.dispatch('aws/ec2', {
      region:            region.value,
      cloudCredentialId: credentialId.value
    });
    getRegions();
    getSshKeys();
    getVpcs();
    getSubnets();
  } else {
    regionInfo.value = [];
    sshKeyInfo.value = [];
    vpcInfo.value = [];
    subnetInfo.value = [];
  }
}, { immediate: true });

</script>

<template>
  <div class="mb-20">
    <RcSection
      :title="t('capa.clusterConfig.title')"
      :expandable="true"
      mode="with-header"
      type="primary"
    >
      <RcSection
        title="General Configuration"
        :expandable="true"
        mode="with-header"
        type="secondary"
      >
        <div class="row">
          <div class="span-4">
            <LabeledSelect
              v-model:value="region"
              :loading="loadingRegions"
              :mode="mode"
              :options="regionOptions"
              required
              :label="t('capa.clusterConfig.region.label')"
              :placeholder="t('capa.clusterConfig.region.placeholder')"
              name="region"
            />
          </div>
        </div>
        <div class="row mb-20">
          <div class="span-4">
            <LabeledSelect
              v-model:value="sshKeyName"
              :loading="loadingSshKeys"
              :mode="mode"
              :options="sshKeyOptions"
              :label="t('capa.clusterConfig.sshKeyName.label')"
              :sub-label="t('capa.clusterConfig.sshKeyName.description')"
            />
          </div>
        </div>
        <RcSection
          :title="t('capa.machineConfig.advanced.tags.title')"
          :expandable="true"
          mode="with-header"
          type="secondary"
          :expanded="false"
        >
          <h5>{{ t('capa.machineConfig.advanced.tags.description') }}</h5>
          <KeyValue
            v-model:value="additionalTags"
            :mode="mode"
            :read-allowed="false"
            :as-map="true"
            :add-label="t('capa.machineConfig.advanced.tags.add')"
            data-testid="capa-resource-tags-input"
          />
        </RcSection>
      </RcSection>

      <RcSection
        :title="t('capa.clusterConfig.network.title')"
        :expandable="true"
        mode="with-header"
        type="secondary"
      >
        <Networking
          v-model:vpc-id="vpcId"
          v-model:subnets="subnets"
          v-model:ipv6="ipv6"
          v-model:security-group-overrides="securityGroupOverrides"
          v-model:additional-control-plane-ingress-rules="additionalControlPlaneIngressRules"
          v-model:additional-node-ingress-rules="additionalNodeIngressRules"
          v-model:cni-ingress-rules="cniIngressRules"
          v-model:use-unmanaged-network="useUnmanagedNetwork"
          v-model:cidr-block="cidrBlock"
          :provisioning-cluster="provisioningCluster"
          :mode="mode"
          :region="region"
          :credentialId="credentialId"
          :vpc-info="vpcInfo"
          :subnet-info="subnetInfo"
          :loading-vpcs="loadingVpcs"
          :loading-subnets="loadingSubnets"
        />
      </RcSection>
    </RcSection>
  </div>
</template>
