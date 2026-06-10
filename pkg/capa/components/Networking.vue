<script setup lang="ts">
import { toRefs, ref, watch, computed } from 'vue';
import { useStore } from 'vuex';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import RadioGroup from '@components/Form/Radio/RadioGroup.vue';
import { useI18n } from '@shell/composables/useI18n';
import { _CREATE } from '@shell/config/query-params';
import { RcSection } from '@components/RcSection';
import { getSubnetDisplayName, getVpcDisplayName } from '@shell/utils/aws';
import * as AWS from '@shell/types/aws-sdk';
import Checkbox from '@components/Form/Checkbox/Checkbox.vue';
import LabeledInput from '@components/Form/LabeledInput/LabeledInput.vue';
import IngressRules from './IngressRules.vue';
import SecurityOverrides from './SecurityOverrides.vue';
import Banner from '@components/Banner/Banner.vue';
import { isCapaManagedVpcId } from '../utils';
import { scrollToBottom } from '@shell/utils/scroll';

defineOptions({ name: 'Networking' });

const emit = defineEmits([
  'update:vpcId',
  'update:subnets',
  'validationChanged',
  'update:ipv6',
  'update:cidrBlock',
  'update:securityGroupOverrides',
  'update:additionalControlPlaneIngressRules',
  'update:additionalNodeIngressRules',
  'update:cniIngressRules',
  'update:useUnmanagedNetwork'
]);

interface Props {
  vpcId: string;
  subnets: {id: string}[];
  cidrBlock?: string;
  ipv6?: {} | null;
  mode?: string;
  credentialId: any;
  region?: string;
  securityGroupOverrides?: {};
  additionalControlPlaneIngressRules?: any[];
  additionalNodeIngressRules?: any[];
  cniIngressRules?: any[];
  vpcInfo?: AWS.VPC[];
  subnetInfo?: AWS.Subnet[];
  loadingVpcs?: boolean;
  loadingSubnets?: boolean;
  useUnmanagedNetwork?: boolean;
  provisioningCluster?: any;
}

const props = withDefaults(defineProps<Props>(), {
  mode:                               _CREATE,
  region:                             '',
  ipv6:                               null,
  cidrBlock:                          '',
  securityGroupOverrides:             () => ({}),
  additionalControlPlaneIngressRules: () => [],
  additionalNodeIngressRules:         () => [],
  cniIngressRules:                    () => [],
  vpcInfo:                            () => [],
  subnetInfo:                         () => [],
  loadingVpcs:                        false,
  loadingSubnets:                     false,
  useUnmanagedNetwork:                false,
  provisioningCluster:                {},
});

const {
  vpcId, subnets, credentialId, region, ipv6, cidrBlock,
  mode, securityGroupOverrides, additionalControlPlaneIngressRules, additionalNodeIngressRules, cniIngressRules,
  vpcInfo, subnetInfo, loadingVpcs, loadingSubnets, useUnmanagedNetwork, provisioningCluster
} = toRefs(props);

const store = useStore();
const { t } = useI18n(store);

const allowAdditionalCPRules = computed(() => !(securityGroupOverrides.value as any)?.controlplane);
const allowAdditionalNodeRules = computed(() => !(securityGroupOverrides.value as any)?.node);
const allowCNIRules = computed(() => allowAdditionalNodeRules.value || allowAdditionalCPRules.value);

const storedCPIngressRules = ref<any[]>([]);
const storedNodeIngressRules = ref<any[]>([]);
const storedCNIIngressRules = ref<any[]>([]);

const provClusterCNI = computed(() => {
  return provisioningCluster?.value?.spec?.rkeConfig?.machineGlobalConfig?.cni;
});

const selectedSubnetIds = computed({
  get: () => (subnets.value || []).map((s) => s.id),
  set: (ids: string[]) => {
    emit('update:subnets', ids.map((id) => ({ id })));
  }
});

const enableIpv6 = computed({
  get() {
    return !!ipv6?.value;
  },
  set(value: boolean) {
    if (value) {
      emit('update:ipv6', {});
    } else {
      emit('update:ipv6', undefined);
    }
  }
});

const networkStrategyOptions = [
  {
    label:       t('capa.clusterConfig.network.strategy.managed.label'),
    value:       false,
    description: t('capa.clusterConfig.network.strategy.managed.description')
  },
  {
    label:       t('capa.clusterConfig.network.strategy.unmanaged.label'),
    value:       true,
    description: t('capa.clusterConfig.network.strategy.unmanaged.description')
  }
];

const vpcOptions = computed(() => {
  if (!vpcInfo.value) {
    return [];
  }

  return vpcInfo.value.map((v) => {
    return { label: getVpcDisplayName(v), value: v.VpcId };
  });
});

const subnetOptions = computed(() => {
  if (!subnetInfo.value) {
    return [];
  }

  return subnetInfo.value.reduce((opts, s) => {
    if (vpcId.value && s.VpcId !== vpcId.value ) {
      return opts;
    }
    opts.push( { label: getSubnetDisplayName(s), value: s.SubnetId });

    return opts;
  }, [] as {label: string, value: string}[]);
});

const isCreate = computed(() => {
  return mode.value === _CREATE;
});

function goToBasicsCniSelect(e: MouseEvent) {
  if ((e?.target as HTMLElement)?.localName === 'a') {
    setTimeout(() => {
      // timeout allows the basic tab to render before scrolling
      scrollToBottom();
    }, 3);
  }
}

watch(useUnmanagedNetwork, (neu) => {
  if (!neu) {
    emit('update:vpcId', '');
    emit('update:subnets', []);
  }
});

watch(vpcId, () => {
  emit('update:subnets', []);
  const cpRules = (additionalControlPlaneIngressRules.value || []).map((r: any) => {
    const { sourceSecurityGroupIDs, ...rest } = r;

    return sourceSecurityGroupIDs ? rest : r;
  });

  emit('update:additionalControlPlaneIngressRules', cpRules);
  const nodeRules = (additionalNodeIngressRules.value || []).map((r: any) => {
    const { sourceSecurityGroupIDs, ...rest } = r;

    return sourceSecurityGroupIDs ? rest : r;
  });

  emit('update:additionalNodeIngressRules', nodeRules);
});

watch(vpcOptions, () => {
  // if users select 'managed networks' the UI will leave vpcId empty and CAPA will populate vpcId
  // on edit, we have to look at the VPC definition to see if its was created by CAPA to know if UI should show 'managed networks' or 'unmanaged networks' selected
  if (vpcId.value && vpcInfo.value) {
    emit('update:useUnmanagedNetwork', isCapaManagedVpcId(vpcId.value, vpcInfo.value));
  }
});

watch(allowAdditionalCPRules, (allowed) => {
  if (!allowed) {
    storedCPIngressRules.value = [...(additionalControlPlaneIngressRules.value || [])];
    emit('update:additionalControlPlaneIngressRules', []);
  } else if (storedCPIngressRules.value.length) {
    emit('update:additionalControlPlaneIngressRules', storedCPIngressRules.value);
    storedCPIngressRules.value = [];
  }
});

watch(allowAdditionalNodeRules, (allowed) => {
  if (!allowed) {
    storedNodeIngressRules.value = [...(additionalNodeIngressRules.value || [])];
    emit('update:additionalNodeIngressRules', []);
  } else if (storedNodeIngressRules.value.length) {
    emit('update:additionalNodeIngressRules', storedNodeIngressRules.value);
    storedNodeIngressRules.value = [];
  }
});

watch(allowCNIRules, (allowed) => {
  if (!allowed) {
    storedCNIIngressRules.value = [...(cniIngressRules.value || [])];
    emit('update:cniIngressRules', []);
  } else if (storedCNIIngressRules.value.length) {
    emit('update:cniIngressRules', storedCNIIngressRules.value);
    storedCNIIngressRules.value = [];
  }
});
</script>

<template>
  <RadioGroup
    :value="useUnmanagedNetwork"
    :label="t('capa.clusterConfig.network.strategy.label')"
    name="network-strategy"
    :options="networkStrategyOptions"
    :mode="mode"
    @update:value="$emit('update:useUnmanagedNetwork', $event)"
  />

  <RcSection
    v-if="useUnmanagedNetwork"
    :title="t('capa.clusterConfig.network.unmanagedSettings.title')"
    type="secondary"
    mode="with-header"
    :expandable="true"
  >
    <div class="mb-10 span-6">
      <LabeledSelect
        :value="vpcId"
        :label="t('capa.clusterConfig.network.vpc.label')"
        :options="vpcOptions"
        :loading="loadingVpcs"
        :sub-label="t('capa.clusterConfig.network.vpc.description')"
        name="vpc"
        required
        @update:value="$emit('update:vpcId', $event)"
      />
    </div>
    <div class="mb-20 span-6">
      <LabeledSelect
        v-model:value="selectedSubnetIds"
        :label="t('capa.clusterConfig.network.subnets.label')"
        :sub-label="t('capa.clusterConfig.network.subnets.description')"
        :options="subnetOptions"
        :loading="loadingSubnets"
        :multiple="true"
        required
        name="subnet"
      />
    </div>
  </RcSection>
  <div
    v-else
    class="row mb-20"
  >
    <div class="col span-6">
      <LabeledInput
        :value="cidrBlock"
        :label="t('capa.clusterConfig.network.vpc.cidrBlock.label')"
        :placeholder="t('capa.clusterConfig.network.vpc.cidrBlock.placeholder')"
        :sub-label="t('capa.clusterConfig.network.vpc.cidrBlock.description')"
        :mode="mode"
        name="cidrBlock"
        :disabled="!isCreate"
        @update:value="$emit('update:cidrBlock', $event)"
      />
    </div>
  </div>
  <div class="row">
    <Checkbox
      v-model:value="enableIpv6"
      :mode="mode"
      :label="t('capa.clusterConfig.network.enableIpv6')"
    />
  </div>
  <RcSection
    :title="t('capa.clusterConfig.network.networkSecurity.title')"
    :expandable="true"
    mode="with-header"
    type="secondary"
  >
    <Banner
      color="warning"
      @click="goToBasicsCniSelect"
    >
      <span v-clean-html="t('capa.clusterConfig.network.cniProviderBanner', { cni: provClusterCNI }, true)" />
    </Banner>
    <RcSection
      v-if="useUnmanagedNetwork"
      :title="t('capa.clusterConfig.network.securityGroups.label')"
      :expandable="true"
      mode="with-header"
      type="secondary"
    >
      <h5>{{ t('capa.clusterConfig.network.securityGroups.description') }}</h5>
      <SecurityOverrides
        :value="securityGroupOverrides"
        :vpc-id="vpcId"
        :region="region"
        :credential-id="credentialId"
        :mode="mode"

        @update:value="$emit('update:securityGroupOverrides', $event)"
      />
    </RcSection>

    <RcSection
      :title="t('capa.clusterConfig.network.additionalControlPlaneIngressRules.label')"
      :expandable="true"
      mode="with-header"
      type="secondary"
    >
      <h5>{{ t('capa.clusterConfig.network.additionalControlPlaneIngressRules.description') }}</h5>
      <IngressRules
        v-if="allowAdditionalCPRules"
        :value="additionalControlPlaneIngressRules"
        :mode="mode"
        :region="region"
        :credential-id="credentialId"
        :vpc-id="vpcId"
        :disable-add="!allowAdditionalCPRules"
        :title-prefix="t('capa.clusterConfig.network.additionalControlPlaneIngressRules.ruleSectionTitlePrefix')"
        @update:value="$emit('update:additionalControlPlaneIngressRules', $event)"
      />
      <Banner
        v-else
        color="info"
        class="override-info-banner"
      >
        {{ t('capa.clusterConfig.network.overrideBanners.controlPlaneOverridden') }}
      </Banner>
    </RcSection>

    <RcSection
      :title="t('capa.clusterConfig.network.additionalNodeIngressRules.label')"
      :expandable="true"
      mode="with-header"
      type="secondary"
    >
      <h5>{{ t('capa.clusterConfig.network.additionalNodeIngressRules.description') }}</h5>
      <IngressRules
        v-if="allowAdditionalNodeRules"
        :value="additionalNodeIngressRules"
        :mode="mode"
        :region="region"
        :credential-id="credentialId"
        :vpc-id="vpcId"
        :disable-add="!allowAdditionalNodeRules"
        :title-prefix="t('capa.clusterConfig.network.additionalNodeIngressRules.ruleSectionTitlePrefix')"
        @update:value="$emit('update:additionalNodeIngressRules', $event)"
      />
      <Banner
        v-else
        color="info"
        class="override-info-banner"
      >
        {{ t('capa.clusterConfig.network.overrideBanners.nodeOverridden') }}
      </Banner>
    </RcSection>

    <RcSection
      :title="t('capa.clusterConfig.network.cniIngressRules.label')"
      :expandable="true"
      mode="with-header"
      type="secondary"
    >
      <Banner
        v-if="!allowAdditionalNodeRules && allowCNIRules"
        color="info"
        class="override-info-banner"
      >
        {{ t('capa.clusterConfig.network.overrideBanners.nodeOverriddenCni') }}
      </Banner>
      <Banner
        v-if="!allowAdditionalCPRules && allowCNIRules"
        color="info"
        class="override-info-banner"
      >
        {{ t('capa.clusterConfig.network.overrideBanners.controlPlaneOverriddenCni') }}
      </Banner>
      <h5>{{ t('capa.clusterConfig.network.cniIngressRules.description') }}</h5>
      <IngressRules
        v-if="allowCNIRules"
        :value="cniIngressRules"
        :mode="mode"
        :region="region"
        :credential-id="credentialId"
        :vpc-id="vpcId"
        :title-prefix="t('capa.clusterConfig.network.cniIngressRules.ruleSectionTitlePrefix')"
        :allow-targets="false"
        @update:value="$emit('update:cniIngressRules', $event)"
      />
      <Banner
        v-else
        color="info"
        class="override-info-banner"
      >
        {{ t('capa.clusterConfig.network.overrideBanners.bothOverridden') }}
      </Banner>
    </RcSection>
  </RcSection>
</template>

<style lang="scss" scoped>
  .banner.override-info-banner {
    margin: 0px;
  }
</style>
