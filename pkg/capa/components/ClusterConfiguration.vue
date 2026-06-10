<script setup lang="ts">
import {
  computed, onMounted, toRefs, ref, WritableComputedRef, watch
} from 'vue';
import { useStore } from 'vuex';
import { useI18n } from '@shell/composables/useI18n';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { RcSection } from '@components/RcSection';
import { _CREATE } from '@shell/config/query-params';
import merge from 'lodash/merge';
import Networking from './Networking.vue';
import { removeEmptyFields } from '../utils';
import { NORMAN } from '@shell/config/types';
import { isEmpty, get, set } from '@shell/utils/object.js';
import KeyValue from '@shell/components/form/KeyValue';
import * as AWS from '@shell/types/aws-sdk';
import { useForm } from 'vee-validate';
import * as validators from '../validators';

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
  return validators.validateIngressRulesCidr(t, additionalRules);
};

const { errors } = useForm({
  validationSchema: {
    vpc:    (val: string) => validators.vpc(t, val, useUnmanagedNetwork.value),
    subnet: (val: string[]) => validators.subnet(t, val, useUnmanagedNetwork.value),
    cidrBlock: (val: string) => validators.cidrBlock(t, val, useUnmanagedNetwork.value),
    region: (val: string) => validators.region(t, val),
    nodeIngressCidr: () => validators.validateIngressRulesCidr(t, additionalNodeIngressRules.value),
    cpIngressCidr: () => validators.validateIngressRulesCidr(t, additionalControlPlaneIngressRules.value),
  }
});

// Helper to create computed properties backed by a nested path on value.value
// `set` from @shell/utils/object creates intermediate objects along the path
function specComputed<T>(path: string, defaultValue: T): WritableComputedRef<T> {
  return computed({
    get: () => get(value.value, path) ?? defaultValue,
    set: (neu: T) => {
      set(value.value, path, neu);
      emit('update:value', value.value);
    },
  });
}

const region = specComputed<string>('spec.region', '');
const sshKeyName = specComputed<string>('spec.sshKeyName', '');
const vpcId = specComputed<string>('spec.network.vpc.id', '');
const cidrBlock = specComputed<string>('spec.network.vpc.cidrBlock', '');
const securityGroupOverrides = specComputed<{}>('spec.network.securityGroupOverrides', {});
const subnets = specComputed<{id: string}[]>('spec.network.subnets', []);
const additionalControlPlaneIngressRules = specComputed<any[]>('spec.network.additionalControlPlaneIngressRules', []);
const additionalNodeIngressRules = specComputed<any[]>('spec.network.additionalNodeIngressRules', []);
const additionalTags = specComputed<{}>('spec.additionalTags', {});
const cniIngressRules = specComputed<any[]>('spec.network.cni.cniIngressRules', []);

const ipv6: WritableComputedRef<object | null> = computed({
  get: () => value?.value?.spec?.network?.ipv6 || null,
  set: (neu: object | undefined) => {
    if (neu) {
      set(value.value, 'spec.network.ipv6', neu);
    } else if (value.value?.spec?.network) {
      delete value.value.spec.network.ipv6;
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
    // can't load region from credential, oh well: load the default region from the aws store
  }
  const region = value.value?.spec?.region || cloudCredential?.amazonec2credentialConfig?.defaultRegion || store.getters['aws/defaultRegion'];

  if (!value.value?.spec?.region) {
    set(value.value, 'spec.region', region);
  }
}

async function getRegions() {
  loadingRegions.value = true;
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

  const vpcs = await store.dispatch('aws/depaginateList', { client: ec2Client.value, cmd: 'describeVpcs' });

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

  const fetchedSubnets = await store.dispatch('aws/depaginateList', { client: ec2Client.value, cmd: 'describeSubnets' });

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
        :title="t('capa.clusterConfig.generalConfiguration.title')"
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
