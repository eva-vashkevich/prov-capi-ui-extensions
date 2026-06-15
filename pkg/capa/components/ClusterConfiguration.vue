<script setup lang="ts">
import {
  computed, onMounted, toRefs, ref, WritableComputedRef, watch
} from 'vue';
import { useStore } from 'vuex';
import { useI18n } from '@shell/composables/useI18n';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import Banner from '@components/Banner/Banner.vue';
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
import {CAPA} from '../labels-annotations'
import type { IngressRule, CNIIngressRule, SubnetSpec, SecurityGroupRole, Tags, RancherAwsCloudCredential } from '../types/capa';

defineOptions({ name: 'ClusterConfiguration' });

const emit = defineEmits<{(e: 'update:value', value: any): void, (e: 'validationChanged', value: boolean): void }>();

const defaultConfig = {
  spec: {
    // TODO nb cni-specific roles
    network: {
      additionalControlPlaneIngressRules: [{
        protocol: '-1', sourceSecurityGroupRoles: ['controlplane', 'node'], description: 'Allow all traffic between control plane and node security groups'
      }],
      additionalNodeIngressRules: [{
        protocol: '-1', sourceSecurityGroupRoles: ['controlplane', 'node'], description: 'Allow all traffic between control plane and node security groups'
      }],
    },
    sshKeyName:               '', // empty string -> no ssh key. unset -> use "default" key
    identityRef:              {  kind: 'AWSClusterStaticIdentity' },
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
if (value.value && !value.value.spec) {
  value.value.spec = {};
}

const store = useStore();
const { t } = useI18n(store);
const credentialErrors = ref<string[]>([]); // errors getting or using rancher cloud cred
const credential = ref<RancherAwsCloudCredential>({}) // rancher cloud credential resource: needed to get an identity reference and default region
const useUnmanagedNetwork = ref(false); // used by a radio in networking and doesn't correspond to anything in cluster config - tracking it here to use w/ validators
const ec2Client = ref(null);
const regionInfo = ref<AWS.EC2Region[]>([]);
const sshKeyInfo = ref([]);
const loadingRegions = ref(false);
const loadingSshKeys = ref(false);
const vpcInfo = ref<AWS.VPC[]>([]);
const subnetInfo = ref<AWS.Subnet[]>([]);
const securityGroupInfo = ref<AWS.SecurityGroup[]>([]);
const loadingVpcs = ref(false);
const loadingSubnets = ref(false);
const loadingSecurityGroups = ref(false);

const { errors: validationErrors } = useForm({
  validationSchema: {
    vpc:    (val: string) => validators.vpc(t, val, useUnmanagedNetwork.value),
    subnet: (val: string[]) => validators.subnet(t, val, useUnmanagedNetwork.value),
    cidrBlock: (val: string) => validators.cidrBlock(t, val, useUnmanagedNetwork.value),
    region: () => validators.region(t, region.value), //TODO nb hack around issue w/ useForm
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
const securityGroupOverrides = specComputed<Partial<Record<SecurityGroupRole, string>>>('spec.network.securityGroupOverrides', {});
const subnets = specComputed<SubnetSpec[]>('spec.network.subnets', []);
const additionalControlPlaneIngressRules = specComputed<IngressRule[]>('spec.network.additionalControlPlaneIngressRules', []);
const additionalNodeIngressRules = specComputed<IngressRule[]>('spec.network.additionalNodeIngressRules', []);
const additionalTags = specComputed<Tags>('spec.additionalTags', {});
const cniIngressRules = specComputed<CNIIngressRule[]>('spec.network.cni.cniIngressRules', []);

// ipv6 is "enabled" by setting an empty object and "disabled" by deleting the ipv6 field
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

const isCreate = computed(()=>{
  return mode.value === _CREATE
})

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
  const region = value.value?.spec?.region || credential?.value?.amazonec2credentialConfig?.defaultRegion || store.getters['aws/defaultRegion'];

  if (!value.value?.spec?.region) {
    set(value.value, 'spec.region', region);
  }
}

async function getCloudCredential(){
  if (!credentialId.value || !isCreate.value) {
    return;
  }
  try{
    credential.value = await store.dispatch('rancher/find', { type: NORMAN.CLOUD_CREDENTIAL, id: credentialId.value });
    initDefaultRegion()
    setIdentityRef()
  } catch (e){
    credentialErrors.value.push(t('capa.errors.fetchingCloudCredential', { error: e }))
  }
}

function setIdentityRef() {
  if (!credential.value || !credential.value.annotations?.[CAPA.IDENTITY_REF]) {
    return;
  }

   set(value.value, 'spec.identityRef.name', credential.value.annotations[CAPA.IDENTITY_REF]);
}

async function getRegions() {
  loadingRegions.value = true;
  if (!ec2Client.value || !region.value || !credentialId.value) {
    regionInfo.value = [];
    loadingRegions.value = false;
    return;
  }

  try {
    const regions = await store.dispatch('aws/depaginateList', { client: ec2Client.value, cmd: 'describeRegions' });

    regionInfo.value = regions || [];
  } catch (e) {
    credentialErrors.value.push(t('capa.errors.fetchingRegions', { error: e }));
  } finally {
    loadingRegions.value = false;
  }
}

async function getSshKeys() {
  loadingSshKeys.value = true;
  if (!ec2Client.value || !region.value || !credentialId.value) {
    sshKeyInfo.value = [];
    loadingSshKeys.value = false;
    return;
  }

  try {
    const keys = await store.dispatch('aws/depaginateList', { client: ec2Client.value, cmd: 'describeKeyPairs' });

    sshKeyInfo.value = keys || [];
  } catch (e) {
    credentialErrors.value.push(t('capa.errors.fetchingSshKeys', { error: e }));
  } finally {
    loadingSshKeys.value = false;
  }
}

async function getVpcs() {
  loadingVpcs.value = true;

  if (!ec2Client.value || !region.value || !credentialId.value) {
    vpcInfo.value = [];
    loadingVpcs.value = false;

    return;
  }

  try {
    const vpcs = await store.dispatch('aws/depaginateList', { client: ec2Client.value, cmd: 'describeVpcs' });

    vpcInfo.value = vpcs || [];
  } catch (e) {
    credentialErrors.value.push(t('capa.errors.fetchingVpcs', { error: e }));
  } finally {
    loadingVpcs.value = false;
  }
}

async function getSubnets() {
  loadingSubnets.value = true;
  if (!ec2Client.value || !region.value || !credentialId.value) {
    subnetInfo.value = [];
    loadingSubnets.value = false;

    return;
  }

  try {
    const fetchedSubnets = await store.dispatch('aws/depaginateList', { client: ec2Client.value, cmd: 'describeSubnets' });

    subnetInfo.value = fetchedSubnets || [];
  } catch (e) {
    credentialErrors.value.push(t('capa.errors.fetchingSubnets', { error: e }));
  } finally {
    loadingSubnets.value = false;
  }
}

async function getSecurityGroups() {
  loadingSecurityGroups.value = true;
  if (!ec2Client.value || !region.value || !credentialId.value) {
    securityGroupInfo.value = [];
    loadingSecurityGroups.value = false;

    return;
  }

  try {
    const securityGroups = await store.dispatch('aws/depaginateList', { client: ec2Client.value, cmd: 'describeSecurityGroups' });

    securityGroupInfo.value = securityGroups || [];
  } catch (e) {
    credentialErrors.value.push(t('capa.errors.fetchingSecurityGroups', { error: e }));
  } finally {
    loadingSecurityGroups.value = false;
  }
}

onMounted(async() => {
  if (mode.value === _CREATE) {
    const valueWithDefaults = merge({}, defaultConfig, value.value);
    const cleanedValueWithDefaults = removeEmptyFields(valueWithDefaults);
    //TODO nb why this line - related to using createPopulated??
    delete cleanedValueWithDefaults.spec.s3Bucket;

    emit('update:value', cleanedValueWithDefaults || {});
  }
});


//validation errors are from useForm and reported in individual inputs
// credential errors are errors getting credential or loading aws data, reported in error banner
watch([validationErrors, credentialErrors], ([validationErrs={}, credErrs=[]]) => {
  emit('validationChanged', isEmpty(validationErrs) && (!credErrs.length || !credErrs.find((e:string) =>e.includes(t('capa.errors.fetchingCloudCredential', { error: '' })))));
});

watch(useUnmanagedNetwork, (neu, old) => {
  if (old && !neu) {
    securityGroupOverrides.value = {};
  }
});


watch([
  () => region.value,
  () => credentialId.value,
], async([newRegion, newCredentialId], [oldRegion, oldCredentialId]) => {
    credentialErrors.value = []
    if(newCredentialId){
      // need to await cloud cred as subsequent functions depend on it
      // the other get* functions are not awaited and loading props are used to display spinners in relevant inputs
      await getCloudCredential();
    }

    if(region.value && credentialId.value){
        ec2Client.value = await store.dispatch('aws/ec2', {
          region:            region.value, 
          cloudCredentialId: credentialId.value
        });

        if(oldRegion && newRegion !== oldRegion && mode.value === _CREATE){
          vpcId.value = ''; // this will trigger removal of any vpc-dependent configuration
          sshKeyName.value = ''
        } else if (!oldRegion) {
          // initial mount: fetch regions without resetting vpc
          getRegions();
        }

        getSshKeys();
        getVpcs();
        getSubnets();
        getSecurityGroups();
    } else {
      vpcInfo.value = []
      sshKeyInfo.value = []
      subnetInfo.value = []
      regionInfo.value = []
      securityGroupInfo.value = []
    }
}, { immediate: true });

</script>

<template>
  <div class="mb-20">
    <Banner v-for="e in credentialErrors" color="error">{{ e }}</Banner>
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
              :disabled="!isCreate"
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
          :security-group-info="securityGroupInfo"
          :loading-vpcs="loadingVpcs"
          :loading-subnets="loadingSubnets"
          :loading-security-groups="loadingSecurityGroups"
        />
      </RcSection>
    </RcSection>
  </div>
</template>
