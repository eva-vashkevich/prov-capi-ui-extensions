
<script setup lang="ts">
import {
  toRefs, ref, watch, computed, nextTick
} from 'vue';
import { _CREATE } from '@shell/config/query-params';
import * as AWS from '@shell/types/aws-sdk';
import { useStore } from 'vuex';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import { useI18n } from '@shell/composables/useI18n';
import KeyValue from '@shell/components/form/KeyValue.vue';
import ButtonDropdown from '@shell/components/ButtonDropdown.vue';
import LabeledInput from '@components/Form/LabeledInput/LabeledInput.vue';
import Select from '@shell/components/form/Select.vue';
import { SECURITY_GROUP_ROLES } from '../machine-config/constants';

defineOptions({ name: 'SecurityGroupOverrides' });

const emit = defineEmits([
  'update:value',
]);

interface Props {
  vpcId: string;
  // TODO nb type as map
  value: any;
  mode?: string;
  credentialId: any;
  region?: string;
}

const props = withDefaults(defineProps<Props>(), {
  mode:   _CREATE,
  region: ''
});

const {
  vpcId, value, credentialId, region
} = toRefs(props);

const store = useStore();
const { t } = useI18n(store);
const securityGroupInfo = ref<AWS.SecurityGroup[]>([]);
const loadingSecurityGroups = ref(false);
const ec2Client = ref(null);
const localValue = ref({ ...value.value });
let updatingFromProp = false;

const securityGroupOptions = computed(() => {
  if (!vpcId.value) {
    return [t('capa.clusterConfig.network.securityGroups.selectVpc')];
  }

  return securityGroupInfo.value.reduce((opts, sg) => {
    if (sg.VpcId === vpcId.value) {
      opts.push({ label: `${ sg.GroupName } (${ sg.Description })`, value: sg.SecurityGroupArn });
    }

    return opts;
  }, [] as any);
});

const securityGroupRoleOptions = computed(() => {
  const inUse = Object.keys(localValue.value || {}).filter((r) => !!localValue.value[r]);

  return SECURITY_GROUP_ROLES.filter((r) => !inUse.includes(r)).map((r) => {
    return { label: t(`capa.clusterConfig.network.securityGroups.roles.${ r }`), value: r };
  });
});

function getRoleLabel(role: string) {
  return t(`capa.clusterConfig.network.securityGroups.roles.${ role }`);
}

function updateRowKey(oldKey: string, newKey: string, value: string) {
  const updated = { ...localValue.value };

  delete updated[oldKey];
  updated[newKey] = value;
  localValue.value = updated;
}

function updateRowValue(key: string, newValue: string) {
  localValue.value = {
    ...localValue.value,
    [key]: newValue
  };
}

async function getSecurityGroups() {
  loadingSecurityGroups.value = true;

  if (!ec2Client.value) {
    securityGroupInfo.value = [];
    loadingSecurityGroups.value = false;

    return;
  }
  
  const securityGroups = await ec2Client.value.describeSecurityGroups({ });

  securityGroupInfo.value = securityGroups?.SecurityGroups || [];
  loadingSecurityGroups.value = false;
}

function addOverride(targetRole: string) {
  // const next = securityGroupRoleOptions?.value?.[0]?.value;

  // Create a new object to ensure reactivity triggers
  localValue.value = {
    ...localValue.value,
    [targetRole]: securityGroupOptions.value[0].value
  };
}

function updateOverrides(neu: Record<string, string>) {
  // Create a new object reference to ensure reactivity
  localValue.value = { ...neu };
}

watch(vpcId, (neu, old) => {
  if (old) {
    Object.keys(localValue.value).forEach((k) => {
      localValue.value[k] = '';
    });
  }
  getSecurityGroups();
});

watch(value, (neu) => {
  // need to track when localValue is updated by the value prop changing (eg security groups cleared out when region/vpc changes in another component)
  // to avoid a loop where the localValue watcher triggers the value watcher triggers the localValue watcher etc
  // setting this back to false in nextTick ensures that when this watcher triggers the localValue watcher initially, updatingFromProp is true and localValue watcher's emit is skipped
  // but subsequent runs triggered by the user updating localValue through form interactions trigger the emit
  updatingFromProp = true;
  localValue.value = { ...neu };
  nextTick(() => {
    updatingFromProp = false;
  });
}, { deep: true });

watch(localValue, (neu) => {
  if (updatingFromProp) return;
  value.value = neu;
  emit('update:value', neu);
});

watch([
  () => region.value,
  () => credentialId.value,
], async([newRegion, newCredentialId]) => {
  if (!!newRegion && !!newCredentialId) {
    ec2Client.value = await store.dispatch('aws/ec2', {
      region:            region.value,
      cloudCredentialId: credentialId.value
    });

    getSecurityGroups();
  } else {
    securityGroupInfo.value = [];
  }
}, { immediate: true });

</script>

<template>
  <div
    v-if="Object.keys(localValue || {}).length"
  >
    <KeyValue
      :value="localValue"
      :mode="mode"
      :add-allowed="false"
      :read-allowed="false"
      :key-label="t('capa.clusterConfig.network.securityGroups.role')"
      :value-label="t('capa.clusterConfig.network.securityGroups.securityGroupId')"
      @update:value="updateOverrides"
    >
      <template #key="{row}">
        <LabeledInput
          class="display-role"
          disabled
          :value="getRoleLabel(row.key)"
          :mode="mode"
          compact
        />
      </template>
      <template #value="{row}">
        <LabeledSelect
          :value="row.value"
          :options="securityGroupOptions"
          :loading="loadingSecurityGroups"
          :mode="mode"
          compact
          @update:value="(newValue) => updateRowValue(row.key, newValue)"
        />
      </template>
    </KeyValue>
  </div>
  <div class="row">
    <ButtonDropdown
      v-if="securityGroupRoleOptions.length"
      :button-label="t('capa.clusterConfig.network.securityGroups.addOverride')"
      :dropdown-options="securityGroupRoleOptions"
      size="sm"
      class="btn btn-sm role-secondary"
      @click-action="e=>addOverride(e.value)"
    />
  </div>
</template>

<style lang="scss" scoped>
.display-role {
  min-height: $unlabeled-input-height;
  padding: 10px;
}
</style>
